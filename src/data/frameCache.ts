/**
 * An on-device cache of frame PNGs under `fetchFrame` (movable-location spec §9). Frames are immutable, so
 * a frame already on the phone is never fetched again, whatever the location. Entries are dropped a week
 * after they were stored. A missing Cache API (plain http) or a failing one only means no caching.
 */
export const FRAME_CACHE = "frames-v1";
export const FRAME_CACHE_MAX_AGE_MS = 604_800_000;

const CACHED_AT = "x-cached-at";

/** `url` from the cache, else from `get`, stored (with its time) if the response is ok. */
export async function cachedGet(
  url: string,
  get: (url: string) => Promise<Response>,
  nowMs: number,
  cs: CacheStorage | undefined = globalThis.caches,
): Promise<Response> {
  let cache: Cache | undefined;
  try {
    cache = await cs?.open(FRAME_CACHE);
    const hit = await cache?.match(url);
    if (hit) return hit;
  } catch {
    cache = undefined;
  }
  const res = await get(url);
  if (cache && res.ok) {
    try {
      const headers = new Headers(res.headers);
      headers.set(CACHED_AT, String(nowMs));
      await cache.put(url, new Response(res.clone().body, { status: res.status, statusText: res.statusText, headers }));
    } catch {
      // Quota or a closed cache: the frame still loads, it just isn't kept.
    }
  }
  return res;
}

/** Deletes entries stored more than `FRAME_CACHE_MAX_AGE_MS` before `nowMs` (or with no time). Returns how many. Never throws. */
export async function sweepFrameCache(nowMs: number, cs: CacheStorage | undefined = globalThis.caches): Promise<number> {
  let deleted = 0;
  try {
    const cache = await cs?.open(FRAME_CACHE);
    if (!cache) return 0;
    for (const req of await cache.keys()) {
      const cachedAt = Number((await cache.match(req))?.headers.get(CACHED_AT));
      if (Number.isFinite(cachedAt) && nowMs - cachedAt <= FRAME_CACHE_MAX_AGE_MS) continue;
      if (await cache.delete(req)) deleted++;
    }
  } catch {
    // Nothing to sweep, or the cache isn't usable.
  }
  return deleted;
}
