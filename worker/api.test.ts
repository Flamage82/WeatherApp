import { describe, expect, it, vi } from "vitest";
import { dayCacheControl, handleApi, type ApiBucket } from "./api";

vi.mock("./ftp", () => ({ openBomFtp: vi.fn() }));
import { radarGlob, shouldRefreshMeta } from "./index";

const NOW = Date.UTC(2026, 9, 27, 3, 0); // 2026-10-27 03:00 UTC
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function fakeBucket(keys: string[], pageSize = 1000, homes: Record<string, string> = {}) {
  const store = new Map<string, Uint8Array | string>([
    ["meta/IDR503.json", JSON.stringify({ fetchedAt: "x" })],
    ["frames/IDR503/202610270200.png", PNG],
    ...keys.map((k) => [k, PNG] as [string, Uint8Array]),
  ]);
  const get = vi.fn(async (key: string) => {
    const v = store.get(key);
    if (v === undefined) return null;
    return {
      body: new Response(v as BodyInit).body,
      httpEtag: '"e"',
    };
  });
  const list = vi.fn(async (opts: { prefix?: string; cursor?: string; limit?: number }) => {
    const all = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const size = Math.min(pageSize, opts.limit ?? Infinity);
    const slice = all.slice(start, start + size);
    const truncated = start + size < all.length;
    return {
      objects: slice.map((key) => ({ key, ...(key in homes ? { customMetadata: { home: homes[key]! } } : {}) })),
      truncated,
      ...(truncated ? { cursor: String(start + size) } : {}),
    };
  });
  return { bucket: { get, list } as unknown as ApiBucket, get, list };
}

const req = (path: string, method = "GET") => new Request(`https://x.test${path}`, { method });

describe("handleApi", () => {
  it("builds the manifest from frame keys: last 24 h only, ascending, status from state", async () => {
    const { bucket, get } = fakeBucket([
      "frames/IDR503/202610260259.png", // 24 h + 1 min old: out
      "frames/IDR503/202610260300.png", // exactly 24 h old: in
      "frames/IDR503/202610262350.png",
      "frames/IDR503/202610250100.png", // two days back: never listed
      "frames/IDR503/202610270010.png",
      "frames/IDR504/202610270000.png", // other product
      "state/marburg.json",
    ]);
    const stateBody = { newest: {}, lastOk: { IDR503: "2026-10-27T02:59:00.000Z" }, lastError: { IDR503: "boom" } };
    get.mockImplementation((async (key: string) =>
      key === "state/marburg.json" ? { json: async () => stateBody } : null) as never);
    const res = await handleApi(req("/api/manifest/IDR503"), bucket, NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    expect(await res.json()).toEqual({
      product: "IDR503",
      frames: ["202610260300", "202610262350", "202610270010", "202610270200"],
      lastFetchOk: "2026-10-27T02:59:00.000Z",
      lastError: "boom",
    });
    expect(get.mock.calls.map((c) => c[0])).toEqual(["state/marburg.json"]);
  });

  it("manifest with missing state has null status; Stapylton products read the stapylton state", async () => {
    const { bucket, get } = fakeBucket([]);
    const res = await handleApi(req("/api/manifest/IDR663"), bucket, NOW);
    expect(await res.json()).toEqual({ product: "IDR663", frames: [], lastFetchOk: null, lastError: null });
    expect(get.mock.calls.map((c) => c[0])).toEqual(["state/stapylton.json"]);
  });

  it("manifest follows list cursors", async () => {
    const { bucket } = fakeBucket(
      ["frames/IDR503/202610262350.png", "frames/IDR503/202610270010.png", "frames/IDR503/202610270020.png"],
      1,
    );
    const res = await handleApi(req("/api/manifest/IDR503"), bucket, NOW);
    expect(((await res.json()) as { frames: string[] }).frames).toEqual([
      "202610262350",
      "202610270010",
      "202610270020",
      "202610270200",
    ]);
  });

  it("unknown manifest product is 404 with no bucket call", async () => {
    const { bucket, get, list } = fakeBucket([]);
    const res = await handleApi(req("/api/manifest/IDR999"), bucket, NOW);
    expect(res.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("serves meta json", async () => {
    const { bucket } = fakeBucket([]);
    const res = await handleApi(req("/api/meta/IDR503"), bucket, NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  it("serves frames as immutable png", async () => {
    const { bucket } = fakeBucket([]);
    const res = await handleApi(req("/api/frame/IDR503/202610270200"), bucket, NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("404s on objects missing from R2", async () => {
    const { bucket } = fakeBucket([]);
    const res = await handleApi(req("/api/frame/IDR503/202610270201"), bucket, NOW);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  const dayKeys = [
    "frames/IDR503/202610260010.png",
    "frames/IDR503/202610260000.png",
    "frames/IDR503/202610262350.png",
    "frames/IDR503/202610270000.png",
    "frames/IDR504/202610260000.png",
  ];

  it("lists a past day ascending and immutable", async () => {
    const { bucket } = fakeBucket(dayKeys);
    const res = await handleApi(req("/api/day/IDR503/20261026"), bucket, NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.json()).toEqual({
      product: "IDR503",
      day: "20261026",
      frames: ["202610260000", "202610260010", "202610262350"],
    });
  });

  it("uses max-age=60 for today", async () => {
    const { bucket } = fakeBucket(dayKeys);
    const res = await handleApi(req("/api/day/IDR503/20261027"), bucket, NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(((await res.json()) as { frames: string[] }).frames).toEqual(["202610270000", "202610270200"]);
  });

  it("treats the 26th as today when now is the 26th", async () => {
    const { bucket } = fakeBucket(dayKeys);
    const res = await handleApi(req("/api/day/IDR503/20261026"), bucket, Date.UTC(2026, 9, 26, 12));
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("404s on future days", async () => {
    const { bucket, list } = fakeBucket(dayKeys);
    const res = await handleApi(req("/api/day/IDR503/20261028"), bucket, NOW);
    expect(res.status).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });

  it("follows list cursors across pages", async () => {
    const { bucket, list } = fakeBucket(dayKeys, 1);
    const res = await handleApi(req("/api/day/IDR503/20261026"), bucket, NOW);
    expect(((await res.json()) as { frames: string[] }).frames).toEqual(["202610260000", "202610260010", "202610262350"]);
    expect(list.mock.calls.length).toBeGreaterThan(1);
  });

  describe("series", () => {
    const keys = ["202610262350", "202610260000", "202610260010"].map((s) => `frames/IDR504/${s}.png`);
    const homes = { [keys[0]!]: "3", [keys[1]!]: "0" }; // the 0010 frame has no home metadata
    const get = (path: string, now = NOW) => {
      const b = fakeBucket(keys, 1, homes);
      return handleApi(req(path), b.bucket, now).then((res) => ({ res, ...b }));
    };

    it("lists ascending points across pages, skipping frames without home, immutable for a past day", async () => {
      const { res, list } = await get("/api/series/IDR504/20261026");
      expect(await res.json()).toEqual({
        product: "IDR504",
        day: "20261026",
        points: [
          ["202610260000", 0],
          ["202610262350", 3],
        ],
      });
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(list.mock.calls.length).toBeGreaterThan(1);
      expect(list.mock.calls[0]![0]).toMatchObject({ include: ["customMetadata"] });
    });

    it("uses max-age=60 for today and an empty list for a day with no frames", async () => {
      const { res } = await get("/api/series/IDR504/20261027");
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
      expect(((await res.json()) as { points: unknown[] }).points).toEqual([]);
    });

    it.each(["20261028", "2026102", "20261340"])("404s on %s without touching the bucket", async (day) => {
      const { res, get: bget, list } = await get(`/api/series/IDR504/${day}`);
      expect(res.status).toBe(404);
      expect(bget).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    });
  });

  it("earliest: the first frame key of the product, from one list call with limit 1", async () => {
    const { bucket, list, get } = fakeBucket([
      "frames/IDR503/202610250100.png",
      "frames/IDR503/202610260000.png",
      "frames/IDR502/202610010000.png", // other product, earlier
      "frames/IDR5030/202501010000.png", // never matches: the prefix ends with "/"
    ]);
    const res = await handleApi(req("/api/earliest/IDR503"), bucket, NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await res.json()).toEqual({ product: "IDR503", stamp: "202610250100" });
    expect(list.mock.calls).toEqual([[{ prefix: "frames/IDR503/", limit: 1 }]]);
    expect(get).not.toHaveBeenCalled();
  });

  it("earliest: stamp null when the product has no frames", async () => {
    const { bucket } = fakeBucket([]);
    const res = await handleApi(req("/api/earliest/IDR664"), bucket, NOW);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ product: "IDR664", stamp: null });
  });

  it.each([
    "/api/earliest/IDR999",
    "/api/earliest/IDR503/202610270000",
    "/api/frame/IDR999/202610270549",
    "/api/frame/IDR503/..%2F..%2Fx",
    "/api/frame/IDR503/2026",
    "/api/manifest/IDR503x",
    "/api/day/IDR503/2026102",
    "/api/day/IDR503/..%2F",
    "/api/day/IDR503/20261340",
  ])("rejects %s without touching the bucket", async (path) => {
    const { bucket, get, list } = fakeBucket([]);
    const res = await handleApi(req(path), bucket, NOW);
    expect(res.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("404s unknown routes and 405s non-GET", async () => {
    const { bucket } = fakeBucket([]);
    expect((await handleApi(req("/api/nope"), bucket, NOW)).status).toBe(404);
    const res = await handleApi(req("/api/manifest/IDR503", "POST"), bucket, NOW);
    expect(res.status).toBe(405);
  });
});

describe("dayCacheControl", () => {
  const midnight = Date.UTC(2026, 9, 27);
  it("is short-lived until 3 h after the day ends", () => {
    expect(dayCacheControl("20261026", midnight + 3_600_000)).toBe("public, max-age=60");
    expect(dayCacheControl("20261026", midnight + 3 * 3_600_000 - 1)).toBe("public, max-age=60");
  });
  it("is immutable once 3 h past the day end", () => {
    expect(dayCacheControl("20261026", midnight + 3 * 3_600_000)).toBe("public, max-age=31536000, immutable");
    expect(dayCacheControl("20261026", midnight + 4 * 3_600_000)).toBe("public, max-age=31536000, immutable");
  });
  it("is short-lived for today and null for future or invalid days", () => {
    expect(dayCacheControl("20261027", midnight + 3_600_000)).toBe("public, max-age=60");
    expect(dayCacheControl("20261028", midnight + 3_600_000)).toBeNull();
    expect(dayCacheControl("20261340", midnight)).toBeNull();
  });
});

describe("day route just after midnight", () => {
  it("does not freeze yesterday's listing 1 h after the day ends", async () => {
    const { bucket } = fakeBucket([]);
    const res = await handleApi(req("/api/day/IDR503/20261026"), bucket, Date.UTC(2026, 9, 27, 1));
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });
});

describe("radarGlob / shouldRefreshMeta", () => {
  it("radarGlob matches only the four products of a radar", () => {
    expect(radarGlob("marburg")).toBe("/anon/gen/radar/IDR50[1-4].T.*.png");
    expect(radarGlob("stapylton")).toBe("/anon/gen/radar/IDR66[1-4].T.*.png");
  });
  it("shouldRefreshMeta is true only at UTC minute 0", () => {
    expect(shouldRefreshMeta(Date.UTC(2026, 9, 27, 3, 0))).toBe(true);
    expect(shouldRefreshMeta(Date.UTC(2026, 9, 27, 3, 0, 59))).toBe(true);
    for (const m of [1, 2, 3, 30, 59]) expect(shouldRefreshMeta(Date.UTC(2026, 9, 27, 3, m))).toBe(false);
  });
});
