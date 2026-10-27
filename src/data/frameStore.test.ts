import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductId } from "../../shared/config";
import type { LevelField } from "../../shared/decodeFrame";
import { msToStamp, stampToMs } from "../../shared/stamps";
import type { Manifest, RadarGeometry } from "../../shared/types";
import type { FlowField } from "../motion/flow";
import { DECODED_CAP_MS, FrameStore, type FrameStoreDeps } from "./frameStore";

const MIN = 60_000;
const H = 3_600_000;
const STEP = 5 * MIN;
/** Newest frame of every product in the default fakes. */
const NEWEST = Date.UTC(2026, 9, 28, 3, 0);

function stampsBetween(from: number, to: number): string[] {
  const out: string[] = [];
  for (let t = from; t <= to; t += STEP) out.push(msToStamp(t));
  return out;
}

type FakeOpts = {
  /** Newest frame per radar (default NEWEST for both). */
  newest?: { marburg?: number; stapylton?: number };
  /** Earliest frame in the archive (fetchEarliest; fetchDay returns [] for days before it). */
  archiveStart?: number;
  /** UTC days (YYYYMMDD) with no frames at all, e.g. a whole-day outage inside the archive. */
  emptyDays?: string[];
  /** Override a product's manifest frames. */
  manifest?: Partial<Record<ProductId, string[]>>;
  now?: number;
  /** Flows resolve only when the test releases them (see `release`). */
  gatedFlows?: boolean;
};

function fakes(opts: FakeOpts = {}) {
  const state = {
    newest: { marburg: opts.newest?.marburg ?? NEWEST, stapylton: opts.newest?.stapylton ?? NEWEST },
    archiveStart: opts.archiveStart ?? Date.UTC(2026, 0, 1),
    emptyDays: new Set(opts.emptyDays ?? []),
    manifest: { ...opts.manifest } as Partial<Record<ProductId, string[]>>,
    now: opts.now ?? NEWEST + 2 * MIN,
  };
  const newestOf = (p: ProductId) => (p.startsWith("IDR50") ? state.newest.marburg : state.newest.stapylton);
  const manifestFrames = (p: ProductId) =>
    state.manifest[p] ?? stampsBetween(Math.max(newestOf(p) - 24 * H, state.archiveStart), newestOf(p));

  const api = {
    fetchManifest: vi.fn(async (p: ProductId): Promise<Manifest> => ({
      product: p, frames: manifestFrames(p), lastFetchOk: null, lastError: null,
    })),
    fetchFrame: vi.fn(async (p: ProductId, stamp: string) => new TextEncoder().encode(`${p}/${stamp}`)),
    fetchMeta: vi.fn(async (p: ProductId): Promise<RadarGeometry> => ({
      product: p, name: p, centre: { lat: -27.7, lon: 152.7 },
      corners: { bl: { lon: 152, lat: -28 }, tl: { lon: 152, lat: -27 }, tr: { lon: 153, lat: -27 }, br: { lon: 153, lat: -28 } },
    })),
    fetchDay: vi.fn(async (p: ProductId, day: string): Promise<string[]> => {
      if (state.emptyDays.has(day)) return [];
      const start = stampToMs(`${day}0000`);
      const from = Math.max(start, state.archiveStart);
      const to = Math.min(start + 24 * H - STEP, newestOf(p));
      return from > to ? [] : stampsBetween(Math.ceil(from / STEP) * STEP, to);
    }),
    fetchEarliest: vi.fn(async (_p: ProductId): Promise<string | null> => msToStamp(state.archiveStart)),
  };
  const decode = vi.fn((png: Uint8Array): LevelField => ({ width: 512, height: 512, data: png }));
  const zero = (): FlowField => ({ gw: 1, gh: 1, data: new Float32Array(2) });
  /** Unanswered gated flow calls, oldest first. */
  const gate: (() => void)[] = [];
  const stats = { maxInFlight: 0 };
  const flow = vi.fn((_a: LevelField, _b: LevelField, _gapMs: number): Promise<FlowField> =>
    opts.gatedFlows
      ? new Promise((res) => {
        gate.push(() => res(zero()));
        stats.maxInFlight = Math.max(stats.maxInFlight, gate.length);
      })
      : Promise.resolve(zero()));
  const deps: FrameStoreDeps = { api, decode, flow, now: () => state.now };
  return { state, api, decode, flow, gate, stats, deps };
}

/**
 * Let fake fetches, decodes and promise chains run. They all resolve in microtasks, which a macrotask
 * drains completely (setTimeout is ~15 ms on Windows, so it's used sparingly).
 */
const settle = async () => {
  for (let k = 0; k < 2; k++) await new Promise((r) => setTimeout(r, 0));
};
const microFlush = async () => {
  for (let k = 0; k < 100; k++) await Promise.resolve();
};

/** Answer gated flows one at a time until none are left. Returns how many were answered. */
async function releaseAll(gate: (() => void)[]): Promise<number> {
  let n = 0;
  await settle();
  for (;;) {
    if (!gate.length) {
      await settle();
      if (!gate.length) return n;
    }
    if (n > 2000) throw new Error("releaseAll: flows never run out");
    gate.shift()!();
    n++;
    await microFlush();
  }
}

const label = (f: LevelField) => new TextDecoder().decode(f.data);
const pairLabel = (call: [LevelField, LevelField, number]) => [label(call[0]), label(call[1])];
const stampOf = (lbl: string) => stampToMs(lbl.split("/")[1]!);
const frameCalls = (api: ReturnType<typeof fakes>["api"]) =>
  api.fetchFrame.mock.calls.map(([p, s]) => ({ p, ms: stampToMs(s) }));

let store: FrameStore | null = null;
afterEach(() => {
  store?.stop();
  store = null;
});

async function started(opts: FakeOpts = {}) {
  const f = fakes(opts);
  store = new FrameStore(f.deps);
  await store.start();
  await store.idle();
  return { ...f, store };
}

describe("FrameStore start", () => {
  it("loads the tape product and IDR503 for the last 2 h only, newest first", async () => {
    const { api, store } = await started();
    const calls = frameCalls(api);
    expect(new Set(calls.map((c) => c.p))).toEqual(new Set(["IDR504", "IDR503"]));
    expect(calls).toHaveLength(2 * 25);
    for (const c of calls) expect(c.ms).toBeGreaterThanOrEqual(NEWEST - 2 * H);
    // First picture fast: the newest frames are requested first.
    expect(calls.slice(0, 2).map((c) => c.ms)).toEqual([NEWEST, NEWEST]);
    expect(store.radar).toBe("marburg");
    expect(store.status).toBe("ok");
    expect(store.newestMs).toBe(NEWEST);
    expect(store.frames("IDR503")).toEqual(stampsBetween(NEWEST - 2 * H, NEWEST).map(stampToMs));
    expect(store.loadedWindow()).toEqual({ start: NEWEST - 2 * H, end: NEWEST });
    // Meta for every range of the active radar, widest to sharpest.
    expect(store.geometries().map((g) => g.product)).toEqual(["IDR501", "IDR502", "IDR503", "IDR504"]);
  });

  it("computes a flow for every adjacent pair, and getPair blends them", async () => {
    const { flow, store } = await started();
    expect(flow).toHaveBeenCalledTimes(2 * 24);
    for (const [, , gapMs] of flow.mock.calls) expect(gapMs).toBe(STEP);
    const pair = store.getPair("IDR503", NEWEST - 2.5 * MIN)!;
    expect(label(pair.a)).toBe(`IDR503/${msToStamp(NEWEST - STEP)}`);
    expect(label(pair.b)).toBe(`IDR503/${msToStamp(NEWEST)}`);
    expect(pair.alpha).toBeCloseTo(0.5);
    expect(pair.cell).toBe(2);
    expect(pair.flow.gw).toBe(1);
  });

  it("stop() during start abandons loading (React StrictMode's discarded mount)", async () => {
    const f = fakes();
    store = new FrameStore(f.deps);
    const p = store.start();
    store.stop();
    await p;
    await store.idle();
    expect(f.api.fetchFrame).not.toHaveBeenCalled();
  });

  it("dispatches change events", async () => {
    const f = fakes();
    store = new FrameStore(f.deps);
    const onChange = vi.fn();
    store.addEventListener("change", onChange);
    await store.start();
    await store.idle();
    expect(onChange).toHaveBeenCalled();
  });
});

describe("FrameStore refresh and caching", () => {
  it("refresh() with one new stamp fetches only that frame and computes one new flow", async () => {
    const { api, flow, state, store } = await started();
    const next = NEWEST + STEP;
    state.manifest.IDR503 = stampsBetween(next - 24 * H, next);
    state.now = next + MIN;
    api.fetchFrame.mockClear();
    flow.mockClear();
    await store.refresh();
    await store.idle();
    expect(frameCalls(api)).toEqual([{ p: "IDR503", ms: next }]);
    expect(flow).toHaveBeenCalledTimes(1);
    expect(label(flow.mock.calls[0]![0])).toBe(`IDR503/${msToStamp(NEWEST)}`);
    expect(label(flow.mock.calls[0]![1])).toBe(`IDR503/${msToStamp(next)}`);
    expect(store.frames("IDR503").at(-1)).toBe(next);
  });

  it("decodes each frame once and caches it", async () => {
    const { api, decode, store } = await started();
    expect(decode).toHaveBeenCalledTimes(50);
    for (let t = NEWEST - 2 * H; t <= NEWEST; t += MIN) store.getPair("IDR503", t);
    store.ensureAround(NEWEST);
    await store.refresh();
    await store.idle();
    expect(decode).toHaveBeenCalledTimes(50);
    expect(api.fetchFrame).toHaveBeenCalledTimes(50);
  });

  it("getPair returns null with fewer than 2 frames", async () => {
    const one = [msToStamp(NEWEST)];
    const { store } = await started({ manifest: { IDR503: one, IDR504: one } });
    expect(store.frames("IDR503")).toEqual([NEWEST]);
    expect(store.getPair("IDR503", NEWEST)).toBeNull();
  });

  it("with no frames anywhere, status is empty and nothing loads", async () => {
    const none = { IDR503: [], IDR504: [], IDR663: [] };
    const { api, store } = await started({ manifest: none });
    expect(store.status).toBe("empty");
    expect(store.newestMs).toBeNull();
    expect(store.frames("IDR503")).toEqual([]);
    expect(store.getPair("IDR503", NEWEST)).toBeNull();
    expect(api.fetchFrame).not.toHaveBeenCalled();
  });
});

describe("FrameStore extendBack", () => {
  it("extendBack(newest - 4 h) fetches only the frames between 4 h and 2 h back", async () => {
    const { api, store } = await started();
    api.fetchFrame.mockClear();
    store.extendBack(NEWEST - 4 * H);
    await store.idle();
    const calls = frameCalls(api);
    expect(calls).toHaveLength(2 * 24);
    for (const c of calls) {
      expect(c.ms).toBeGreaterThanOrEqual(NEWEST - 4 * H);
      expect(c.ms).toBeLessThan(NEWEST - 2 * H);
    }
    expect(api.fetchDay).not.toHaveBeenCalled();
    expect(store.loadedWindow().start).toBe(NEWEST - 4 * H);
    expect(store.getPair("IDR503", NEWEST - 3.5 * H)).not.toBeNull();
  });

  it("extendBack(newest - 30 h) fetches each uncovered UTC day once and merges in order", async () => {
    const { api, store } = await started();
    const to = NEWEST - 30 * H; // 2026-10-26 21:00 UTC; the manifest starts 2026-10-27 03:00
    store.extendBack(to);
    store.extendBack(to);
    await store.idle();
    store.extendBack(to);
    await store.idle();
    const days = api.fetchDay.mock.calls.map(([p, d]) => `${p}/${d}`).sort();
    expect(days).toEqual(["IDR503/20261026", "IDR503/20261027", "IDR504/20261026", "IDR504/20261027"]);
    for (const p of ["IDR503", "IDR504"] as const) {
      expect(store.frames(p)).toEqual(stampsBetween(to, NEWEST).map(stampToMs));
    }
    expect(store.loadedWindow()).toEqual({ start: to, end: NEWEST });
  });

  // Amended by controller ruling R22: the floor is the server's earliest stamp, not the first empty day.
  it("skips an empty day inside the archive and stops exactly at the earliest stamp", async () => {
    const archiveStart = Date.UTC(2026, 9, 25, 20, 0);
    const { api, store } = await started({ archiveStart, emptyDays: ["20261026"] }); // a whole-day outage
    store.extendBack(NEWEST - 60 * H); // 2026-10-25 15:00, before the archive began
    await store.idle();
    expect(api.fetchDay.mock.calls.map(([p, d]) => `${p}/${d}`).sort()).toEqual([
      "IDR503/20261025", "IDR503/20261026", "IDR503/20261027",
      "IDR504/20261025", "IDR504/20261026", "IDR504/20261027",
    ]);
    // Days are fetched one at a time, newest first.
    expect(api.fetchDay.mock.calls.filter(([p]) => p === "IDR503").map(([, d]) => d)).toEqual([
      "20261027", "20261026", "20261025",
    ]);
    expect(api.fetchEarliest.mock.calls.map(([p]) => p).sort()).toEqual(["IDR503", "IDR504"]);
    expect(store.loadedWindow().start).toBe(archiveStart);
    expect(store.frames("IDR503")[0]).toBe(archiveStart);
    // The outage day is a gap between real frames, not the end of the archive.
    expect(store.frames("IDR503")).toContain(Date.UTC(2026, 9, 25, 23, 55));
    expect(store.frames("IDR503")).not.toContain(Date.UTC(2026, 9, 26, 12, 0));
    api.fetchDay.mockClear();
    store.extendBack(NEWEST - 100 * H);
    await store.idle();
    expect(api.fetchDay).not.toHaveBeenCalled();
    expect(api.fetchEarliest).toHaveBeenCalledTimes(2); // learned once per product
    expect(store.loadedWindow().start).toBe(archiveStart);
  });

  it("several empty days in a row are all crossed back to the earliest stamp", async () => {
    const archiveStart = Date.UTC(2026, 9, 22, 6, 0);
    const { api, store } = await started({ archiveStart, emptyDays: ["20261023", "20261024", "20261025", "20261026"] });
    store.extendBack(NEWEST - 200 * H);
    await store.idle();
    expect(api.fetchDay.mock.calls.filter(([p]) => p === "IDR503").map(([, d]) => d)).toEqual([
      "20261027", "20261026", "20261025", "20261024", "20261023", "20261022",
    ]);
    expect(store.loadedWindow().start).toBe(archiveStart);
  });

  it("no day is requested when the product has no earliest stamp", async () => {
    const f = fakes();
    f.api.fetchEarliest.mockResolvedValue(null);
    store = new FrameStore(f.deps);
    await store.start();
    store.extendBack(NEWEST - 30 * H);
    await store.idle();
    expect(f.api.fetchDay).not.toHaveBeenCalled();
    expect(store.loadedWindow().start).toBe(NEWEST - 24 * H); // the manifest's first stamp
  });
});

describe("FrameStore memory cap", () => {
  it("exports DECODED_CAP_MS verbatim", () => {
    expect(DECODED_CAP_MS).toBe(21_600_000);
  });

  it("ensureAround(t) keeps at most 6 h (+1 frame) decoded, within ±3 h of t", async () => {
    const { store } = await started();
    store.extendBack(NEWEST - 10 * H);
    await store.idle();
    // Sweep the playhead over the 10 h so every part of it has been decoded at some point.
    for (const back of [0, 3, 6, 9]) {
      store.ensureAround(NEWEST - back * H);
      await store.idle();
    }
    const t = NEWEST - 5 * H;
    store.ensureAround(t);
    await store.idle();
    for (const p of ["IDR503", "IDR504"] as const) {
      const d = store.decoded(p);
      expect(d.length).toBeLessThanOrEqual(DECODED_CAP_MS / STEP + 1);
      expect(d.length).toBeGreaterThan(60);
      for (const ms of d) expect(Math.abs(ms - t)).toBeLessThanOrEqual(DECODED_CAP_MS / 2);
    }
    expect(store.getPair("IDR503", t)).not.toBeNull();
    const far = NEWEST - 30 * MIN;
    expect(store.getPair("IDR503", far)).toBeNull();
    store.ensureAround(far);
    await store.idle();
    expect(store.getPair("IDR503", far)).not.toBeNull();
  });

  it("re-decoding after eviction refetches (HTTP cache) and recomputes the flow", async () => {
    const { api, store } = await started();
    store.extendBack(NEWEST - 10 * H);
    await store.idle();
    store.ensureAround(NEWEST - 9 * H);
    await store.idle();
    api.fetchFrame.mockClear();
    store.ensureAround(NEWEST);
    await store.idle();
    expect(frameCalls(api).some((c) => c.ms === NEWEST)).toBe(true);
    expect(store.getPair("IDR503", NEWEST - MIN)).not.toBeNull();
  });
});

describe("FrameStore live follow", () => {
  it("ensureAround(null) follows the newest frame again after a scrub pinned the focus", async () => {
    const { state, store } = await started();
    store.ensureAround(NEWEST - H); // the user scrubbed back
    await store.idle();
    const later = NEWEST + 5 * H; // more than 4 h of new frames arrive
    state.newest.marburg = later;
    state.now = later + MIN;
    await store.refresh();
    await store.idle();
    // Still pinned: the newest frames lie outside the 6 h window around the old focus.
    expect(store.decoded("IDR503")).not.toContain(later);
    expect(store.getPair("IDR503", later - 2.5 * MIN)).toBeNull();
    store.ensureAround(null); // back to live
    await store.idle();
    expect(store.decoded("IDR503")).toContain(later);
    expect(store.getPair("IDR503", later - 2.5 * MIN)).not.toBeNull();
    // And it keeps following as more frames arrive.
    const later2 = later + 4 * H;
    state.newest.marburg = later2;
    state.now = later2 + MIN;
    await store.refresh();
    await store.idle();
    expect(store.getPair("IDR503", later2 - 2.5 * MIN)).not.toBeNull();
  });
});

describe("FrameStore flow scheduling", () => {
  const dist = (call: [LevelField, LevelField, number], focus: number) => {
    const [a, b] = pairLabel(call).map(stampOf) as [number, number];
    return Math.abs((a + b) / 2 - focus);
  };

  it("sends one flow at a time, nearest the focus first", async () => {
    const f = fakes({ gatedFlows: true });
    store = new FrameStore(f.deps);
    void store.start();
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(50));
    await settle();
    expect(f.flow).toHaveBeenCalledTimes(1); // the rest wait in the store, not in a worker queue
    const focus = NEWEST - 2 * H; // the far end of the 48 wanted pairs
    store.ensureAround(focus);
    await releaseAll(f.gate);
    const calls = f.flow.mock.calls;
    expect(calls).toHaveLength(48);
    expect(f.stats.maxInFlight).toBe(1);
    const d = calls.slice(1).map((c) => dist(c, focus));
    for (let k = 1; k < d.length; k++) expect(d[k]).toBeGreaterThanOrEqual(d[k - 1]!);
    expect(d[0]).toBe(2.5 * MIN); // the very next flow is the pair right at the focus
    expect(store.getPair("IDR503", focus + MIN)).not.toBeNull();
  });

  it("never sends a flow for a pair evicted while it waited", async () => {
    const f = fakes({ gatedFlows: true });
    store = new FrameStore(f.deps);
    void store.start();
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(50));
    store.extendBack(NEWEST - 10 * H);
    await settle();
    store.ensureAround(NEWEST - 9 * H); // window [−10 h, −4 h]: the newest pairs are evicted unsent
    await settle();
    const sent = f.flow.mock.calls.length;
    expect(sent).toBe(1);
    await releaseAll(f.gate);
    const lo = NEWEST - 10 * H, hi = NEWEST - 4 * H;
    for (const c of f.flow.mock.calls.slice(sent)) {
      for (const ms of pairLabel(c).map(stampOf)) {
        expect(ms).toBeGreaterThanOrEqual(lo);
        expect(ms).toBeLessThanOrEqual(hi);
      }
    }
    expect(f.flow.mock.calls.length - sent).toBe(2 * 72); // exactly the pairs in the window
    expect(store.getPair("IDR503", NEWEST - 7 * H)).not.toBeNull();
  });

  it("re-requests a flow discarded on arrival once its pair is decoded again", async () => {
    const f = fakes({ gatedFlows: true });
    store = new FrameStore(f.deps);
    void store.start();
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(50));
    await settle();
    const first = pairLabel(f.flow.mock.calls[0]!); // in flight: a pair at the newest end
    store.extendBack(NEWEST - 10 * H);
    store.ensureAround(NEWEST - 9 * H); // evict that pair while its flow is computing
    await settle();
    f.gate.shift()!(); // its flow arrives for an evicted pair: discarded
    await settle();
    store.ensureAround(null); // back to live: the pair is decoded again
    await releaseAll(f.gate);
    await store.idle();
    const same = f.flow.mock.calls.filter((c) => pairLabel(c).join() === first.join());
    expect(same).toHaveLength(2);
    const [p, s] = first[0]!.split("/") as [ProductId, string];
    expect(store.getPair(p, stampToMs(s) + 2.5 * MIN)).not.toBeNull();
  });
});

describe("FrameStore products and radar switching", () => {
  it("ensureProduct lazy-loads another range of the active radar, and ignores other radars", async () => {
    const { api, store } = await started();
    api.fetchFrame.mockClear();
    store.ensureProduct("IDR663");
    store.ensureProduct("IDR502");
    await store.idle();
    const calls = frameCalls(api);
    expect(new Set(calls.map((c) => c.p))).toEqual(new Set(["IDR502"]));
    expect(calls).toHaveLength(25);
    expect(store.getPair("IDR502", NEWEST - MIN)).not.toBeNull();
    expect(store.frames("IDR663")).toEqual([]);
  });

  it("uses Stapylton when Marburg is stale, then switches the whole store back", async () => {
    const stale = NEWEST - 25 * MIN;
    const { api, state, store } = await started({ newest: { marburg: stale } });
    expect(store.radar).toBe("stapylton");
    expect(new Set(frameCalls(api).map((c) => c.p))).toEqual(new Set(["IDR663"]));
    expect(store.geometries().map((g) => g.product)).toEqual(["IDR661", "IDR662", "IDR663", "IDR664"]);
    expect(store.getPair("IDR663", NEWEST - MIN)).not.toBeNull();

    state.newest.marburg = NEWEST;
    api.fetchFrame.mockClear();
    await store.refresh();
    await store.idle();
    expect(store.radar).toBe("marburg");
    expect(new Set(frameCalls(api).map((c) => c.p))).toEqual(new Set(["IDR504", "IDR503"]));
    expect(store.getPair("IDR663", NEWEST - MIN)).toBeNull();
    expect(store.decoded("IDR663")).toEqual([]);
    expect(store.geometries().map((g) => g.product)).toEqual(["IDR501", "IDR502", "IDR503", "IDR504"]);
  });
});
