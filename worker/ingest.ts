import { MANIFEST_SPAN_MS, PRODUCTS, RADARS, type ProductId } from "../shared/config";
import { sampleHomeFromPng } from "../shared/homeSample";
import { msToStamp, stampToMs } from "../shared/stamps";
import type { RadarGeometry } from "../shared/types";
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

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** BOM's FTP server answers a glob that matches nothing with "450/550 No files found" instead of an empty list. */
const isNoFiles = (e: unknown) => /\b[45]50\b.*no files found/i.test(msg(e));

/** Stored meta is the geometry plus `fetchedAt`; anything without corners is treated as no geometry. */
const asGeometry = (m: Partial<RadarGeometry> | null): RadarGeometry | null => (m?.corners ? (m as RadarGeometry) : null);

/**
 * Refreshes `meta/{product}.json` when missing or stale and returns the geometry, if there is one.
 * If refetching the `.map` fails, the stale stored geometry is returned together with the error.
 */
async function fetchMeta(
  ftp: FtpSource,
  bucket: BucketLike,
  product: ProductId,
  nowMs: number,
): Promise<{ geometry: RadarGeometry | null; error: string | null }> {
  const key = `meta/${product}.json`;
  const existing = await bucket.get(key);
  let stale: RadarGeometry | null = null;
  if (existing) {
    const meta = (await existing.json()) as Partial<RadarGeometry> & { fetchedAt?: string };
    stale = asGeometry(meta);
    const age = nowMs - Date.parse(meta.fetchedAt ?? "");
    if (age >= 0 && age < META_MAX_AGE_MS) return { geometry: stale, error: null };
  }
  try {
    const bytes = await ftp.retrieve(`${MAP_DIR}/${product}.map`);
    const geometry = parseMapFile(new TextDecoder().decode(bytes));
    await bucket.put(key, JSON.stringify({ ...geometry, fetchedAt: new Date(nowMs).toISOString() }));
    return { geometry, error: null };
  } catch (e) {
    return { geometry: stale, error: msg(e) };
  }
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
 * `radarGlob` is listed once for all of the radar's products and every missing in-window frame is
 * downloaded (no caps). A frame counts as missing when its stamp is listed, within 24 h, and has no R2
 * key (one key listing per product with in-window stamps), so a stamp that shows up late is still fetched.
 * There are no per-product manifests: `/api/manifest` is built from an R2 list.
 * `state/{radar}.json` is read once and written once, only if changed.
 *
 * `newest[product]` (informational) only moves to the newest listed in-window stamp, and only when every
 * missing in-window frame was stored in this run. A listing error, a failed download or put, or a tape
 * product with no geometry (its frames must carry the home level) leaves it unchanged and stores nothing,
 * so the next run retries.
 */
export async function runIngest(deps: {
  ftp: FtpSource;
  bucket: BucketLike;
  nowMs: number;
  radar: "marburg" | "stapylton";
  radarGlob: string;
  refreshMeta?: boolean;
}): Promise<IngestReport> {
  const { ftp, bucket, nowMs, radar } = deps;
  const products = RADARS[radar].products;
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

  let combined = new Map<ProductId, string[]>();
  let combinedError: string | null = null;
  try {
    combined = parseListing(await ftp.list(deps.radarGlob));
  } catch (e) {
    if (!isNoFiles(e)) combinedError = msg(e);
  }

  for (const product of products) {
    const listed = combined.get(product) ?? [];
    let frameError: string | null = combinedError;
    let metaError: string | null = null;

    const known = state.newest[product];
    const inWindow = listed.filter((s) => stampToMs(s) >= cutoff);
    const listedNewest = inWindow[inWindow.length - 1];
    let fetched = 0;

    // The tape product's frames carry the rain level at home, which needs the geometry before the first put.
    const isTape = product === RADARS[radar].tapeProduct;
    let geometry: RadarGeometry | null = null;
    if (isTape && refreshMeta) {
      try {
        const m = await fetchMeta(ftp, bucket, product, nowMs);
        geometry = m.geometry;
        if (m.error) metaError = `meta: ${m.error}`;
      } catch (e) {
        metaError = `meta: ${msg(e)}`;
      }
    }

    if (!frameError && listedNewest) {
      try {
        const stored = await storedAfter(bucket, product, msToStamp(cutoff - 60_000));
        const missing = inWindow.filter((s) => !stored.has(s)).reverse(); // newest first
        if (isTape && missing.length > 0 && !geometry) {
          geometry = asGeometry((await (await bucket.get(`meta/${product}.json`))?.json()) as Partial<RadarGeometry> | null);
          if (!geometry) throw new Error("no geometry");
        }
        for (const stamp of missing) {
          const bytes = await ftp.retrieve(`/anon/gen/radar/${product}.T.${stamp}.png`);
          let customMetadata: Record<string, string> | undefined;
          if (geometry) {
            try {
              customMetadata = { home: String(await sampleHomeFromPng(bytes, geometry)) };
            } catch (e) {
              report.errors.push(`${product}: home sample ${stamp}: ${msg(e)}`);
            }
          }
          await bucket.put(`frames/${product}/${stamp}.png`, bytes, {
            httpMetadata: { contentType: "image/png" },
            ...(customMetadata ? { customMetadata } : {}),
          });
          fetched++;
        }
        if (fetched === missing.length && (!known || listedNewest > known)) {
          state.newest[product] = listedNewest;
          stateChanged = true;
        }
      } catch (e) {
        frameError = msg(e);
      }
    }
    report.added[product] = fetched;

    if (refreshMeta && !isTape) {
      try {
        const m = await fetchMeta(ftp, bucket, product, nowMs);
        if (m.error) metaError = `meta: ${m.error}`;
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
