import { describe, expect, it, vi } from "vitest";
import type { ProductId } from "../shared/config";
import type { FtpSource } from "./ftpProtocol";
import { runIngest, type BucketLike, type IngestState } from "./ingest";

const NOW = Date.UTC(2026, 9, 27, 6, 0); // 202610270600
const HOUR = 3_600_000;
const enc = new TextEncoder();
const GLOB = "/anon/gen/radar/IDR50[1-4].T.*.png";
const MARBURG: ProductId[] = ["IDR501", "IDR502", "IDR503", "IDR504"];
const S1 = "202610270549";
const S2 = "202610270554";
const S3 = "202610270559";

function mapText(p: string) {
  return [
    `${p}.map`,
    "50 Marburg (128 km)",
    "projection = Gnomonic",
    "center_longitude = 152.5",
    "center_latitude = -27.6",
    "lon0 = 150",
    "lat0 = -29",
    "lon1 = 150",
    "lat1 = -26",
    "lon2 = 155",
    "lat2 = -26",
    "lon3 = 155",
    "lat3 = -29",
  ].join("\n");
}

function fakeBucket() {
  const store = new Map<string, Uint8Array | string>();
  const put = vi.fn(async (key: string, value: unknown, _opts?: unknown) => {
    store.set(key, value as Uint8Array | string);
    return null;
  });
  const get = vi.fn(async (key: string) => {
    const v = store.get(key);
    if (v === undefined) return null;
    const bytes = typeof v === "string" ? enc.encode(v) : v;
    return { json: async () => JSON.parse(new TextDecoder().decode(bytes)) };
  });
  const list = vi.fn(async (opts: { prefix?: string; startAfter?: string }) => {
    const keys = [...store.keys()]
      .filter((k) => k.startsWith(opts.prefix ?? "") && (!opts.startAfter || k > opts.startAfter))
      .sort();
    return { objects: keys.map((key) => ({ key })), truncated: false };
  });
  return { store, put, get, list, bucket: { get, put, list } as unknown as BucketLike };
}
type B = ReturnType<typeof fakeBucket>;

function fakeFtp(listing: Partial<Record<ProductId, string[]>>, opts: { failRetrieve?: (path: string) => boolean } = {}) {
  const list = vi.fn(async (glob: string) => {
    const m = /radar\/(IDR\d{3})\./.exec(glob);
    if (!m) {
      return [
        ...Object.entries(listing).flatMap(([p, stamps]) => stamps!.map((s) => `${p}.T.${s}.png`)),
        "IDR504.T.202610279999.png.tmp",
      ];
    }
    return (listing[m[1] as ProductId] ?? []).map((s) => `${m[1]}.T.${s}.png`);
  });
  const retrieve = vi.fn(async (path: string) => {
    if (opts.failRetrieve?.(path)) throw new Error("boom " + path);
    return enc.encode("data");
  });
  const ftp: FtpSource = { list, retrieve, close: vi.fn(async () => {}) } as unknown as FtpSource;
  return { ftp, list, retrieve };
}
type F = ReturnType<typeof fakeFtp>;

const seedState = (b: B, partial: Partial<IngestState> = {}) =>
  b.store.set("state/marburg.json", JSON.stringify({ newest: {}, lastOk: {}, lastError: {}, ...partial }));
const state = (b: B) => JSON.parse(b.store.get("state/marburg.json") as string) as IngestState;
const allNewest = (s: string) => Object.fromEntries(MARBURG.map((p) => [p, s]));
const freshMeta = () => new Date(NOW - HOUR).toISOString();
const seedMeta = (b: B, p: string, fetchedAt = freshMeta()) =>
  b.store.set(`meta/${p}.json`, JSON.stringify({ product: p, fetchedAt }));
const putKeys = (b: B) => b.put.mock.calls.map((c) => String(c[0])).sort();
const frameFor = (p: string, s: string) => `/anon/gen/radar/${p}.T.${s}.png`;

const run = (b: B, f: F, extra: object = {}) =>
  runIngest({ ftp: f.ftp, bucket: b.bucket, nowMs: NOW, radar: "marburg", radarGlob: GLOB, refreshMeta: false, ...extra });

describe("runIngest", () => {
  it("one new frame: 1 retrieve, 1 frame put, 1 state put, no manifest key touched", async () => {
    const b = fakeBucket();
    seedState(b, { newest: allNewest(S1) });
    b.get.mockClear();
    const f = fakeFtp({ IDR501: [S1], IDR502: [S1], IDR503: [S1, S2], IDR504: [S1] });
    const r = await run(b, f);
    expect(f.retrieve).toHaveBeenCalledTimes(1);
    expect(f.retrieve).toHaveBeenCalledWith(frameFor("IDR503", S2));
    expect(r.added.IDR503).toBe(1);
    expect(b.put.mock.calls.find((c) => c[0] === `frames/IDR503/${S2}.png`)![2]).toEqual({
      httpMetadata: { contentType: "image/png" },
    });
    expect(putKeys(b)).toEqual([`frames/IDR503/${S2}.png`, "state/marburg.json"]);
    expect(b.get.mock.calls.map((c) => c[0])).toEqual(["state/marburg.json"]);
    expect(b.list).not.toHaveBeenCalled();
    expect(state(b).newest.IDR503).toBe(S2);
    expect(state(b).lastOk.IDR503).toBe(new Date(NOW).toISOString());
    expect(state(b).lastOk.IDR501).toBeUndefined();
  });

  it("idle run: 1 state get, 0 puts, 0 retrieves, 1 list", async () => {
    const b = fakeBucket();
    seedState(b, { newest: allNewest(S1) });
    b.get.mockClear();
    const f = fakeFtp(Object.fromEntries(MARBURG.map((p) => [p, [S1]])));
    await run(b, f);
    expect(b.get.mock.calls.map((c) => c[0])).toEqual(["state/marburg.json"]);
    expect(b.put).not.toHaveBeenCalled();
    expect(f.retrieve).not.toHaveBeenCalled();
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.list).toHaveBeenCalledWith(GLOB);
  });

  it("partial failure: stored frame stays, newest does not advance, lastError set, retry skips stored", async () => {
    const b = fakeBucket();
    seedState(b, { newest: allNewest(S1) });
    const failS2 = (p: string) => p === frameFor("IDR503", S2);
    const f = fakeFtp({ IDR503: [S1, S2, S3] }, { failRetrieve: failS2 });
    const r = await run(b, f);
    expect(f.retrieve.mock.calls.map((c) => c[0])).toEqual([frameFor("IDR503", S3), frameFor("IDR503", S2)]);
    expect(b.store.has(`frames/IDR503/${S3}.png`)).toBe(true);
    expect(b.store.has(`frames/IDR503/${S2}.png`)).toBe(false);
    expect(state(b).newest.IDR503).toBe(S1);
    expect(state(b).lastError.IDR503).toContain("boom");
    expect(state(b).lastOk.IDR503).toBeUndefined();
    expect(r.errors).toHaveLength(1);

    const f2 = fakeFtp({ IDR503: [S1, S2, S3] });
    await run(b, f2);
    expect(f2.retrieve.mock.calls.map((c) => c[0])).toEqual([frameFor("IDR503", S2)]);
    expect(state(b).newest.IDR503).toBe(S3);
    expect(state(b).lastError.IDR503).toBeNull();
  });

  it("a frame put that fails leaves state behind", async () => {
    const b = fakeBucket();
    seedState(b, { newest: allNewest(S1) });
    const orig = b.put.getMockImplementation()!;
    b.put.mockImplementation(async (k: string, v: unknown, o?: unknown) => {
      if (k.startsWith("frames/")) throw new Error("r2 down");
      return orig(k, v, o);
    });
    const f = fakeFtp({ IDR503: [S1, S2] });
    const r = await run(b, f);
    expect(state(b).newest.IDR503).toBe(S1);
    expect(state(b).lastError.IDR503).toContain("r2 down");
    expect(r.errors[0]).toContain("r2 down");
  });

  it("a state put failure goes into report.errors and does not throw", async () => {
    const b = fakeBucket();
    seedState(b, { newest: allNewest(S1) });
    const orig = b.put.getMockImplementation()!;
    b.put.mockImplementation(async (k: string, v: unknown, o?: unknown) => {
      if (k.startsWith("state/")) throw new Error("state down");
      return orig(k, v, o);
    });
    const f = fakeFtp({ IDR503: [S1, S2] });
    const r = await run(b, f);
    expect(r.errors).toEqual([expect.stringContaining("state down")]);
    expect(b.store.has(`frames/IDR503/${S2}.png`)).toBe(true);
  });

  it("one product failing does not stop the others", async () => {
    const b = fakeBucket();
    seedState(b, { newest: allNewest(S1) });
    const f = fakeFtp(
      { IDR503: [S1, S2], IDR504: [S1, S2] },
      { failRetrieve: (p) => p.includes("IDR504.T.") },
    );
    const r = await run(b, f);
    expect(r.errors).toHaveLength(1);
    expect(b.store.has(`frames/IDR503/${S2}.png`)).toBe(true);
    expect(state(b).newest.IDR503).toBe(S2);
    expect(state(b).newest.IDR504).toBe(S1);
    expect(state(b).lastError.IDR504).toContain("boom");
  });

  it("caps downloads per product, newest first, and a backlog continues without repeats", async () => {
    const b = fakeBucket();
    seedState(b, { newest: allNewest("202610270500") });
    const stamps = Array.from({ length: 7 }, (_, i) => `2026102705${String(10 + i * 5)}`);
    const deps = { IDR501: stamps, IDR502: stamps };
    const f = fakeFtp(deps);
    const r = await run(b, f);
    expect(r.added.IDR501).toBe(2);
    expect(r.added.IDR502).toBe(2);
    expect(f.retrieve.mock.calls.filter((c) => String(c[0]).includes("IDR501")).map((c) => c[0])).toEqual([
      frameFor("IDR501", stamps[6]!),
      frameFor("IDR501", stamps[5]!),
    ]);
    expect(state(b).newest.IDR501).toBe("202610270500"); // backlog: not advanced
    const f2 = fakeFtp(deps);
    await run(b, f2, { maxDownloads: 10 });
    expect(f2.retrieve.mock.calls.filter((c) => String(c[0]).includes("IDR501"))).toHaveLength(5);
    expect(state(b).newest.IDR501).toBe(stamps[6]);
  });

  it("ignores stamps older than 24h and never deletes frames", async () => {
    const b = fakeBucket();
    seedState(b, { newest: allNewest("202610250500") });
    const f = fakeFtp({ IDR503: ["202610250505", S1] });
    await run(b, f);
    expect(f.retrieve.mock.calls.map((c) => c[0])).toEqual([frameFor("IDR503", S1)]);
    expect(state(b).newest.IDR503).toBe(S1);
    expect((b.bucket as unknown as Record<string, unknown>).delete).toBeUndefined();
  });

  it("missing state: nothing redownloaded when frames are already stored, state is written", async () => {
    const b = fakeBucket();
    b.store.set(`frames/IDR503/${S1}.png`, new Uint8Array([1]));
    b.store.set(`frames/IDR503/${S2}.png`, new Uint8Array([1]));
    const f = fakeFtp({ IDR503: [S1, S2] });
    await run(b, f);
    expect(f.retrieve).not.toHaveBeenCalled();
    expect(state(b).newest.IDR503).toBe(S2);
  });

  it("an unreadable state is treated as empty", async () => {
    const b = fakeBucket();
    b.store.set("state/marburg.json", "{corrupt");
    const f = fakeFtp({ IDR503: [S1] });
    const r = await run(b, f);
    expect(r.errors).toEqual([]);
    expect(state(b).newest.IDR503).toBe(S1);
  });

  it("treats a 450/550 list error as no files", async () => {
    const b = fakeBucket();
    seedState(b, { newest: allNewest(S1) });
    const f = fakeFtp({});
    f.list.mockRejectedValueOnce(new Error("FTP NLST: 550 No files found"));
    const r = await run(b, f);
    expect(r.errors).toEqual([]);
    expect(b.put).not.toHaveBeenCalled();
  });

  it("a list failure records lastError for every product", async () => {
    const b = fakeBucket();
    seedState(b, { newest: allNewest(S1) });
    const f = fakeFtp({});
    f.list.mockRejectedValueOnce(new Error("FTP NLST: 421 gone"));
    await run(b, f);
    for (const p of MARBURG) expect(state(b).lastError[p]).toContain("421");
  });

  it("without radarGlob each product is listed with its own glob", async () => {
    const b = fakeBucket();
    seedState(b, { newest: allNewest(S1) });
    const f = fakeFtp({ IDR503: [S1, S2] });
    await run(b, f, { radarGlob: undefined });
    expect(f.list.mock.calls.map((c) => c[0])).toEqual(MARBURG.map((p) => `/anon/gen/radar/${p}.T.*.png`));
    expect(f.retrieve).toHaveBeenCalledTimes(1);
  });

  it("fetches meta when missing or older than 7 days, else skips; never when refreshMeta is false", async () => {
    const mapPath = "/anon/gen/radar_transparencies/coordinates/IDR503.map";
    const count = async (seed?: string, refreshMeta = true) => {
      const b = fakeBucket();
      seedState(b, { newest: allNewest(S1) });
      for (const p of MARBURG) if (p !== "IDR503") seedMeta(b, p);
      if (seed) seedMeta(b, "IDR503", seed);
      const f = fakeFtp({});
      f.retrieve.mockImplementation(async (p: string) => enc.encode(p === mapPath ? mapText("IDR503") : "x"));
      await run(b, f, { refreshMeta });
      return { n: f.retrieve.mock.calls.filter((c) => c[0] === mapPath).length, b };
    };
    const missing = await count();
    expect(missing.n).toBe(1);
    expect(JSON.parse(missing.b.store.get("meta/IDR503.json") as string).fetchedAt).toBe(new Date(NOW).toISOString());
    expect((await count(new Date(NOW - 8 * 24 * HOUR).toISOString())).n).toBe(1);
    expect((await count(new Date(NOW - 6 * 24 * HOUR).toISOString())).n).toBe(0);
    expect((await count(undefined, false)).n).toBe(0);
  });

  it("meta failure does not block frames", async () => {
    const b = fakeBucket();
    seedState(b, { newest: allNewest(S1) });
    for (const p of MARBURG) if (p !== "IDR503") seedMeta(b, p);
    const f = fakeFtp({ IDR503: [S1, S2] }, { failRetrieve: (p) => p.endsWith(".map") });
    const r = await run(b, f, { refreshMeta: true });
    expect(b.store.has(`frames/IDR503/${S2}.png`)).toBe(true);
    expect(r.errors).toHaveLength(1);
    expect(state(b).lastError.IDR503).toContain("meta");
    expect(state(b).newest.IDR503).toBe(S2);
  });
});
