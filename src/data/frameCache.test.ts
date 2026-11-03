import { describe, expect, it, vi } from "vitest";
import { cachedGet, FRAME_CACHE, FRAME_CACHE_MAX_AGE_MS, sweepFrameCache } from "./frameCache";

const NOW = Date.UTC(2026, 10, 3, 3, 0);
const DAY = 86_400_000;
const URL_A = "https://x.test/api/frame/IDR504/202611030250";
const URL_B = "https://x.test/api/frame/IDR504/202611030255";

/** An in-memory CacheStorage: one cache per name, keyed by URL. */
function fakeCaches(opts: { putFails?: boolean } = {}) {
  const entries = new Map<string, Response>();
  const urlOf = (r: RequestInfo) => (typeof r === "string" ? r : (r as Request).url);
  const cache = {
    match: async (r: RequestInfo) => entries.get(urlOf(r))?.clone(),
    put: async (r: RequestInfo, res: Response) => {
      if (opts.putFails) throw new Error("quota");
      entries.set(urlOf(r), res);
    },
    delete: async (r: RequestInfo) => entries.delete(urlOf(r)),
    keys: async () => [...entries.keys()].map((u) => new Request(u)),
  };
  const open = vi.fn(async (_name: string) => cache);
  return { cs: { open } as unknown as CacheStorage, entries, open };
}

const png = () => new Response(new Uint8Array([1, 2, 3]));
const bytes = async (r: Response) => [...new Uint8Array(await r.arrayBuffer())];

describe("cachedGet", () => {
  it("serves a second request for the same URL from the cache", async () => {
    const { cs, open } = fakeCaches();
    const get = vi.fn(async (_u: string) => png());
    await cachedGet(URL_A, get, NOW, cs);
    expect(await bytes(await cachedGet(URL_A, get, NOW, cs))).toEqual([1, 2, 3]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(FRAME_CACHE);
  });

  it("doesn't cache a response that isn't ok", async () => {
    const { cs, entries } = fakeCaches();
    const get = vi.fn(async (_u: string) => new Response("nope", { status: 404 }));
    expect((await cachedGet(URL_A, get, NOW, cs)).status).toBe(404);
    expect(entries.size).toBe(0);
  });

  it("goes to the network alone when there is no Cache API", async () => {
    const get = vi.fn(async (_u: string) => png());
    expect(await bytes(await cachedGet(URL_A, get, NOW, undefined))).toEqual([1, 2, 3]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("still returns the body when put fails (quota)", async () => {
    const { cs } = fakeCaches({ putFails: true });
    const get = vi.fn(async (_u: string) => png());
    expect(await bytes(await cachedGet(URL_A, get, NOW, cs))).toEqual([1, 2, 3]);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("sweepFrameCache", () => {
  it("deletes entries cached more than 7 days ago and keeps newer ones", async () => {
    const { cs, entries } = fakeCaches();
    const get = async (_u: string) => png();
    await cachedGet(URL_A, get, NOW - 8 * DAY, cs);
    await cachedGet(URL_B, get, NOW - DAY, cs);
    expect(FRAME_CACHE_MAX_AGE_MS).toBe(7 * DAY);
    expect(await sweepFrameCache(NOW, cs)).toBe(1);
    expect([...entries.keys()]).toEqual([URL_B]);
  });
});
