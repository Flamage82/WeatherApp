import { MANIFEST_SPAN_MS, PRODUCTS, RADARS, type ProductId } from "../shared/config";
import { msToStamp, stampToMs } from "../shared/stamps";
import type { FtpSource } from "./ftpProtocol";
import { parseListing } from "./listing";
import { parseMapFile } from "./mapFile";

export type BucketLike = Pick<R2Bucket, "get" | "put" | "list">;

export type IngestReport = {
  added: Record<ProductId, number>;
  errors: string[];
};

/** R2 `state/{radar}.json`. `/api/manifest` reads lastOk/lastError from it. */
export type IngestState = {
  newest: Partial<Record<ProductId, string>>;
  lastOk: Partial<Record<ProductId, string>>;
  lastError: Partial<Record<ProductId, string | null>>;
};

const META_MAX_AGE_MS = 7 * 86_400_000;
const MAP_DIR = "/anon/gen/radar_transparencies/coordinates";
const DEFAULT_MAX_DOWNLOADS = 2;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A glob matching nothing may surface as an FTP 450/550 rather than an empty list. */
const isNoFiles = (e: unknown) => /\b[45]50\b/.test(msg(e));

async function fetchMeta(ftp: FtpSource, bucket: BucketLike, product: ProductId, nowMs: number) {
  const key = `meta/${product}.json`;
  const existing = await bucket.get(key);
  if (existing) {
    const { fetchedAt } = (await existing.json()) as { fetchedAt?: string };
    const age = nowMs - Date.parse(fetchedAt ?? "");
    if (age >= 0 && age < META_MAX_AGE_MS) return;
  }
  const bytes = await ftp.retrieve(`${MAP_DIR}/${product}.map`);
  const geometry = parseMapFile(new TextDecoder().decode(bytes));
  await bucket.put(key, JSON.stringify({ ...geometry, fetchedAt: new Date(nowMs).toISOString() }));
}

/** Stamps already stored in R2 after `afterStamp` (a plain key listing, no JSON). */
async function storedAfter(bucket: BucketLike, product: ProductId, afterStamp: string): Promise<Set<string>> {
  const prefix = `frames/${product}/`;
  const out = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor ? { prefix, cursor } : { prefix, startAfter: `${prefix}${afterStamp}.png` });
    for (const o of page.objects) out.add(o.key.slice(prefix.length, -4));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/**
 * `radarGlob`, when given, is listed once for all products; otherwise each product is
 * listed with its own glob. There are no per-product manifests: `/api/manifest` is built
 * from an R2 list. `state/{radar}.json` is read once and written once, only if changed.
 *
 * State advancement rule: `newest[product]` only ever moves to the newest listed in-window stamp,
 * and only when every in-window stamp newer than the old `newest` is stored afterwards, i.e. it was
 * already there or was downloaded and put in this run. A listing error, a failed download or put,
 * or a backlog left by the per-product cap leaves it unchanged, so the next run retries. Stamps
 * above `newest` that did get stored are skipped on retry via one R2 key listing.
 */
export async function runIngest(deps: {
  ftp: FtpSource;
  bucket: BucketLike;
  nowMs: number;
  radar: "marburg" | "stapylton";
  radarGlob?: string;
  maxDownloads?: number; // per product
  refreshMeta?: boolean;
}): Promise<IngestReport> {
  const { ftp, bucket, nowMs, radar } = deps;
  const products = RADARS[radar].products;
  const perProductCap = deps.maxDownloads ?? DEFAULT_MAX_DOWNLOADS;
  const refreshMeta = deps.refreshMeta ?? true;
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = nowMs - MANIFEST_SPAN_MS;
  const cutoffStamp = msToStamp(cutoff);
  const report: IngestReport = {
    added: Object.fromEntries(PRODUCTS.map((p) => [p, 0])) as Record<ProductId, number>,
    errors: [],
  };

  const stateKey = `state/${radar}.json`;
  let state: IngestState = { newest: {}, lastOk: {}, lastError: {} };
  try {
    const obj = await bucket.get(stateKey);
    if (obj) {
      const s = (await obj.json()) as Partial<IngestState>;
      state = { newest: s.newest ?? {}, lastOk: s.lastOk ?? {}, lastError: s.lastError ?? {} };
    }
  } catch {
    // unreadable state only costs one key listing per product with news
  }
  let stateChanged = false;

  let combined: Map<ProductId, string[]> | null = null;
  let combinedError: string | null = null;
  const list = async (glob: string) => {
    try {
      return parseListing(await ftp.list(glob));
    } catch (e) {
      if (isNoFiles(e)) return new Map<ProductId, string[]>();
      throw e;
    }
  };
  if (deps.radarGlob) {
    try {
      combined = await list(deps.radarGlob);
    } catch (e) {
      combinedError = msg(e);
    }
  }

  for (const product of products) {
    let listed: string[] = [];
    let frameError: string | null = combinedError;
    let metaError: string | null = null;
    if (!frameError) {
      try {
        listed = (combined ?? (await list(`/anon/gen/radar/${product}.T.*.png`))).get(product) ?? [];
      } catch (e) {
        frameError = msg(e);
      }
    }

    const known = state.newest[product];
    const listedNewest = listed[listed.length - 1];
    let fetched = 0;

    if (!frameError && listedNewest && (!known || listedNewest > known)) {
      try {
        const todo = listed.filter((s) => (!known || s > known) && stampToMs(s) >= cutoff).reverse(); // newest first
        let missing = todo;
        if (todo.length > 1) {
          const stored = await storedAfter(bucket, product, known && known > cutoffStamp ? known : cutoffStamp);
          missing = todo.filter((s) => !stored.has(s));
        }
        for (const stamp of missing.slice(0, perProductCap)) {
          const bytes = await ftp.retrieve(`/anon/gen/radar/${product}.T.${stamp}.png`);
          await bucket.put(`frames/${product}/${stamp}.png`, bytes, { httpMetadata: { contentType: "image/png" } });
          fetched++;
        }
        if (fetched === missing.length && todo.length > 0) {
          state.newest[product] = todo[0];
          stateChanged = true;
        }
      } catch (e) {
        frameError = msg(e);
      }
    }
    report.added[product] = fetched;

    if (refreshMeta) {
      try {
        await fetchMeta(ftp, bucket, product, nowMs);
      } catch (e) {
        metaError = `meta: ${msg(e)}`;
      }
    }

    if (frameError) report.errors.push(`${product}: ${frameError}`);
    if (metaError) report.errors.push(`${product}: ${metaError}`);
    const error = frameError ?? metaError;
    if ((state.lastError[product] ?? null) !== error) {
      state.lastError[product] = error;
      stateChanged = true;
    }
    if (fetched > 0 && !frameError) {
      state.lastOk[product] = nowIso;
      stateChanged = true;
    }
  }

  if (stateChanged) {
    try {
      await bucket.put(stateKey, JSON.stringify(state), { httpMetadata: { contentType: "application/json" } });
    } catch (e) {
      report.errors.push(`state write: ${msg(e)}`);
    }
  }

  return report;
}
