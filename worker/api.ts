import { MANIFEST_SPAN_MS, PRODUCTS, RADARS, type ProductId } from "../shared/config";
import { msToStamp, stampToMs } from "../shared/stamps";
import type { Manifest, SeriesDay } from "../shared/types";

export type ApiBucket = Pick<R2Bucket, "get" | "list">;

const JSON_CT = "application/json; charset=utf-8";
const IMMUTABLE = "public, max-age=31536000, immutable";
const DAY_MS = 86_400_000;

const json = (body: unknown, status = 200, cache?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_CT, ...(cache ? { "cache-control": cache } : {}) },
  });

const notFound = () => json({ error: "not found" }, 404);

const isProduct = (s: string): s is ProductId => (PRODUCTS as readonly string[]).includes(s);

function dayToMs(day: string): number {
  const y = +day.slice(0, 4);
  const m = +day.slice(4, 6);
  const d = +day.slice(6, 8);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  // Reject impossible dates such as 20261340.
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? ms : NaN;
}

const DAY_SETTLE_MS = 2 * 3_600_000;

/**
 * Cache-Control for a UTC day (YYYYMMDD) of archived data, or null when the day is invalid or in the future (404).
 * A day is final only 2 h after it ends, since ingest lags the radar and backfills can land after midnight.
 */
export function dayCacheControl(day: string, nowMs: number): string | null {
  const dayMs = dayToMs(day);
  if (Number.isNaN(dayMs) || dayMs > nowMs) return null;
  return nowMs >= dayMs + DAY_MS + DAY_SETTLE_MS ? IMMUTABLE : "public, max-age=60";
}

async function object(bucket: ApiBucket, key: string, contentType: string, cache: string) {
  const obj = await bucket.get(key);
  if (!obj) return notFound();
  return new Response(obj.body, { headers: { "content-type": contentType, "cache-control": cache } });
}

async function listStamps(bucket: ApiBucket, product: ProductId, day: string): Promise<string[]> {
  const prefix = `frames/${product}/${day}`;
  const stamps: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const o of page.objects) stamps.push(o.key.slice(-16, -4));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return stamps;
}

type StateLike = { lastOk?: Record<string, string>; lastError?: Record<string, string | null> };

/** Built on request from today's and yesterday's frame keys; ok/error status comes from the ingest state. */
async function buildManifest(bucket: ApiBucket, product: ProductId, nowMs: number): Promise<Manifest> {
  const radar = RADARS.marburg.products.includes(product) ? "marburg" : "stapylton";
  const days = [msToStamp(nowMs - DAY_MS).slice(0, 8), msToStamp(nowMs).slice(0, 8)];
  const readState = async (): Promise<StateLike | null> => {
    try {
      const o = await bucket.get(`state/${radar}.json`);
      return o ? ((await o.json()) as StateLike) : null;
    } catch {
      return null;
    }
  };
  const [state, yesterday, today] = await Promise.all([
    readState(),
    listStamps(bucket, product, days[0]!),
    listStamps(bucket, product, days[1]!),
  ]);
  const cutoff = nowMs - MANIFEST_SPAN_MS;
  const frames = [...yesterday, ...today]
    .filter((s) => stampToMs(s) >= cutoff)
    .sort();
  return {
    product,
    frames,
    lastFetchOk: state?.lastOk?.[product] ?? null,
    lastError: state?.lastError?.[product] ?? null,
  };
}

export async function handleApi(req: Request, bucket: ApiBucket, nowMs: number): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const parts = new URL(req.url).pathname.split("/"); // ["", "api", kind, ...]
  const [, api, kind, product, arg, ...rest] = parts;
  if (api !== "api" || rest.length || !product || !isProduct(product)) return notFound();

  switch (kind) {
    case "manifest":
      if (arg !== undefined) return notFound();
      return json(await buildManifest(bucket, product, nowMs), 200, "public, max-age=30");
    case "meta":
      if (arg !== undefined) return notFound();
      return object(bucket, `meta/${product}.json`, JSON_CT, "public, max-age=86400");
    case "earliest": {
      // The archive floor for the client's scroll-back. R2 lists keys in lexicographic order, which for
      // frames/{product}/{YYYYMMDDHHMM}.png is chronological, so the first key is the earliest frame.
      if (arg !== undefined) return notFound();
      const prefix = `frames/${product}/`;
      const first = (await bucket.list({ prefix, limit: 1 })).objects[0];
      const stamp = first ? first.key.slice(prefix.length, -4) : null;
      return json({ product, stamp }, 200, "public, max-age=3600");
    }
    case "frame":
      if (!arg || !/^\d{12}$/.test(arg)) return notFound();
      return object(bucket, `frames/${product}/${arg}.png`, "image/png", IMMUTABLE);
    case "day": {
      if (!arg || !/^\d{8}$/.test(arg)) return notFound();
      const dayCache = dayCacheControl(arg, nowMs);
      if (!dayCache) return notFound();
      const prefix = `frames/${product}/${arg}`;
      const frames: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor });
        for (const o of page.objects) frames.push(o.key.slice(prefix.length - arg.length, -4));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      frames.sort();
      return json({ product, day: arg, frames }, 200, dayCache);
    }
    case "series": {
      // Rain level at home per frame, recorded at ingest as `home` custom metadata on the frame object.
      if (!arg || !/^\d{8}$/.test(arg)) return notFound();
      const dayCache = dayCacheControl(arg, nowMs);
      if (!dayCache) return notFound();
      const prefix = `frames/${product}/${arg}`;
      const points: SeriesDay["points"] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
        for (const o of page.objects) {
          const home = o.customMetadata?.home;
          if (home !== undefined) points.push([o.key.slice(-16, -4), Number(home)]);
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      points.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      return json({ product, day: arg, points }, 200, dayCache);
    }
    default:
      return notFound();
  }
}
