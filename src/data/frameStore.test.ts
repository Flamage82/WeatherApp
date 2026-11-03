import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductId } from "../../shared/config";
import type { LevelField } from "../../shared/decodeFrame";
import { msToStamp, stampToMs } from "../../shared/stamps";
import type { Manifest, RadarGeometry } from "../../shared/types";
import type { FlowField } from "../motion/flow";
import { DECODED_CAP_MS, FrameStore, OUTER_DECODED_CAP_MS, type FrameStoreDeps } from "./frameStore";

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
  /**
   * Flows are measured: a 31 x 31 field with every cell `valid` (zero motion), as `computeFlow` gives.
   * "dry": the same field with no valid cell, as `computeFlow` gives when no rain matched.
   */
  validFlows?: boolean | "dry";
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
  const zero = (): FlowField =>
    opts.validFlows
      ? {
        gw: 31, gh: 31, data: new Float32Array(31 * 31 * 2),
        valid: new Uint8Array(31 * 31).fill(opts.validFlows === "dry" ? 0 : 1),
      }
      : { gw: 1, gh: 1, data: new Float32Array(2) };
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
  it("loads the tape product for the last 2 h and only IDR503's newest 4 frames, newest first", async () => {
    const { api, store } = await started();
    const calls = frameCalls(api);
    expect(new Set(calls.map((c) => c.p))).toEqual(new Set(["IDR504", "IDR503"]));
    expect(calls.filter((c) => c.p === "IDR504")).toHaveLength(25);
    expect(calls.filter((c) => c.p === "IDR503").map((c) => c.ms).sort()).toEqual(
      [3, 2, 1, 0].map((k) => NEWEST - k * STEP),
    );
    for (const c of calls.filter((c) => c.p === "IDR504")) expect(c.ms).toBeGreaterThanOrEqual(NEWEST - 2 * H);
    // First picture fast: the tape's newest pair is requested first, then IDR503's newest frames.
    expect(calls.slice(0, 6)).toEqual([
      { p: "IDR504", ms: NEWEST }, { p: "IDR504", ms: NEWEST - STEP },
      ...[0, 1, 2, 3].map((k) => ({ p: "IDR503", ms: NEWEST - k * STEP })),
    ]);
    expect(store.radar).toBe("marburg");
    expect(store.status).toBe("ok");
    expect(store.newestMs).toBe(NEWEST);
    expect(store.frames("IDR503")).toEqual(stampsBetween(NEWEST - 2 * H, NEWEST).map(stampToMs));
    expect(store.loadedWindow()).toEqual({ start: NEWEST - 2 * H, end: NEWEST });
    // Meta for every range of the active radar, widest to sharpest.
    expect(store.geometries().map((g) => g.product)).toEqual(["IDR501", "IDR502", "IDR503", "IDR504"]);
  });

  it("computes a flow for every adjacent tape pair and IDR503's newest 3, and getPair blends them", async () => {
    const { flow, store } = await started();
    expect(flow).toHaveBeenCalledTimes(24 + 3);
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
    expect(decode).toHaveBeenCalledTimes(29);
    for (let t = NEWEST - 2 * H; t <= NEWEST; t += MIN) store.getPair("IDR504", t);
    store.ensureAround(NEWEST);
    await store.refresh();
    await store.idle();
    expect(decode).toHaveBeenCalledTimes(29);
    expect(api.fetchFrame).toHaveBeenCalledTimes(29);
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
    expect(calls).toHaveLength(24);
    for (const c of calls) {
      expect(c.p).toBe("IDR504");
      expect(c.ms).toBeGreaterThanOrEqual(NEWEST - 4 * H);
      expect(c.ms).toBeLessThan(NEWEST - 2 * H);
    }
    expect(api.fetchDay).not.toHaveBeenCalled();
    expect(store.loadedWindow().start).toBe(NEWEST - 4 * H);
    expect(store.getPair("IDR504", NEWEST - 3.5 * H)).not.toBeNull();
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
    expect(days).toEqual(["IDR504/20261026", "IDR504/20261027"]); // IDR503 only keeps its newest frames
    expect(store.frames("IDR504")).toEqual(stampsBetween(to, NEWEST).map(stampToMs));
    expect(store.loadedWindow()).toEqual({ start: to, end: NEWEST });
  });

  // Amended by controller ruling R22: the floor is the server's earliest stamp, not the first empty day.
  it("skips an empty day inside the archive and stops exactly at the earliest stamp", async () => {
    const archiveStart = Date.UTC(2026, 9, 25, 20, 0);
    const { api, store } = await started({ archiveStart, emptyDays: ["20261026"] }); // a whole-day outage
    store.extendBack(NEWEST - 60 * H); // 2026-10-25 15:00, before the archive began
    await store.idle();
    expect(api.fetchDay.mock.calls.map(([p, d]) => `${p}/${d}`).sort()).toEqual([
      "IDR504/20261025", "IDR504/20261026", "IDR504/20261027",
    ]);
    // Days are fetched one at a time, newest first.
    expect(api.fetchDay.mock.calls.filter(([p]) => p === "IDR504").map(([, d]) => d)).toEqual([
      "20261027", "20261026", "20261025",
    ]);
    expect(api.fetchEarliest.mock.calls.map(([p]) => p).sort()).toEqual(["IDR504"]);
    expect(store.loadedWindow().start).toBe(archiveStart);
    expect(store.frames("IDR504")[0]).toBe(archiveStart);
    // The outage day is a gap between real frames, not the end of the archive.
    expect(store.frames("IDR504")).toContain(Date.UTC(2026, 9, 25, 23, 55));
    expect(store.frames("IDR504")).not.toContain(Date.UTC(2026, 9, 26, 12, 0));
    api.fetchDay.mockClear();
    store.extendBack(NEWEST - 100 * H);
    await store.idle();
    expect(api.fetchDay).not.toHaveBeenCalled();
    expect(api.fetchEarliest).toHaveBeenCalledTimes(1); // learned once per product
    expect(store.loadedWindow().start).toBe(archiveStart);
  });

  it("several empty days in a row are all crossed back to the earliest stamp", async () => {
    const archiveStart = Date.UTC(2026, 9, 22, 6, 0);
    const { api, store } = await started({ archiveStart, emptyDays: ["20261023", "20261024", "20261025", "20261026"] });
    store.extendBack(NEWEST - 200 * H);
    await store.idle();
    expect(api.fetchDay.mock.calls.filter(([p]) => p === "IDR504").map(([, d]) => d)).toEqual([
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
    const d = store.decoded("IDR504");
    expect(d.length).toBeLessThanOrEqual(DECODED_CAP_MS / STEP + 1);
    expect(d.length).toBeGreaterThan(60);
    for (const ms of d) expect(Math.abs(ms - t)).toBeLessThanOrEqual(DECODED_CAP_MS / 2);
    expect(store.getPair("IDR504", t)).not.toBeNull();
    const far = NEWEST - 30 * MIN;
    expect(store.getPair("IDR504", far)).toBeNull();
    store.ensureAround(far);
    await store.idle();
    expect(store.getPair("IDR504", far)).not.toBeNull();
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
    expect(store.getPair("IDR504", NEWEST - MIN)).not.toBeNull();
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
    expect(store.decoded("IDR504")).not.toContain(later);
    expect(store.getPair("IDR504", later - 2.5 * MIN)).toBeNull();
    store.ensureAround(null); // back to live
    await store.idle();
    expect(store.decoded("IDR504")).toContain(later);
    expect(store.getPair("IDR504", later - 2.5 * MIN)).not.toBeNull();
    // And it keeps following as more frames arrive.
    const later2 = later + 4 * H;
    state.newest.marburg = later2;
    state.now = later2 + MIN;
    await store.refresh();
    await store.idle();
    expect(store.getPair("IDR504", later2 - 2.5 * MIN)).not.toBeNull();
  });
});

describe("FrameStore flow scheduling", () => {
  const dist = (call: [LevelField, LevelField, number], focus: number) => {
    const [a, b] = pairLabel(call).map(stampOf) as [number, number];
    return Math.abs((a + b) / 2 - focus);
  };

  it("sends one flow at a time, the tape's pairs nearest the focus first", async () => {
    const f = fakes({ gatedFlows: true });
    store = new FrameStore(f.deps);
    void store.start();
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(29));
    await settle();
    expect(f.flow).toHaveBeenCalledTimes(1); // the rest wait in the store, not in a worker queue
    const focus = NEWEST - 2 * H; // the far end of the 24 wanted tape pairs
    store.ensureAround(focus);
    await releaseAll(f.gate);
    const calls = f.flow.mock.calls;
    expect(calls).toHaveLength(24 + 3);
    expect(f.stats.maxInFlight).toBe(1);
    // IDR503's 3 newest pairs (nowcast support) come right after the tape's focus pair.
    expect(calls.slice(2, 5).map((c) => label(c[0]).split("/")[0])).toEqual(["IDR503", "IDR503", "IDR503"]);
    const d = calls.slice(1).filter((c) => label(c[0]).startsWith("IDR504")).map((c) => dist(c, focus));
    for (let k = 1; k < d.length; k++) expect(d[k]).toBeGreaterThanOrEqual(d[k - 1]!);
    expect(d[0]).toBe(2.5 * MIN); // the very next flow is the pair right at the focus
    expect(store.getPair("IDR504", focus + MIN)).not.toBeNull();
  });

  it("never sends a flow for a pair evicted while it waited", async () => {
    const f = fakes({ gatedFlows: true });
    store = new FrameStore(f.deps);
    void store.start();
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(29));
    store.extendBack(NEWEST - 10 * H);
    await settle();
    store.ensureAround(NEWEST - 9 * H); // window [−10 h, −4 h]: the newest tape pairs are evicted unsent
    await settle();
    const sent = f.flow.mock.calls.length;
    expect(sent).toBe(1);
    await releaseAll(f.gate);
    const lo = NEWEST - 10 * H, hi = NEWEST - 4 * H;
    // IDR503 keeps its newest frames whatever the focus (they feed the nowcast), so only IDR504 is windowed.
    const tape = f.flow.mock.calls.slice(sent).filter((c) => label(c[0]).startsWith("IDR504"));
    for (const c of tape) {
      for (const ms of pairLabel(c).map(stampOf)) {
        expect(ms).toBeGreaterThanOrEqual(lo);
        expect(ms).toBeLessThanOrEqual(hi);
      }
    }
    expect(tape).toHaveLength(72); // exactly the pairs in the window
    expect(store.getPair("IDR504", NEWEST - 7 * H)).not.toBeNull();
  });

  it("re-requests a flow discarded on arrival once its pair is decoded again", async () => {
    const f = fakes({ gatedFlows: true });
    store = new FrameStore(f.deps);
    void store.start();
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(29));
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

describe("FrameStore nested nowcast", () => {
  it("'now' is the tape product's newest frame even when IDR503 publishes later", async () => {
    const later = stampsBetween(NEWEST + 2 * MIN - 24 * H, NEWEST + 2 * MIN);
    const { store } = await started({ manifest: { IDR503: later } });
    expect(store.frames("IDR503").at(-1)).toBe(NEWEST + 2 * MIN);
    expect(store.loadedWindow().end).toBe(NEWEST);
  });

  it("tapeProducts is the tape product then its nowcast support, finest first", async () => {
    const { store } = await started();
    expect(store.tapeProducts()).toEqual(["IDR504", "IDR503"]);
    expect(new FrameStore(fakes().deps).tapeProducts()).toEqual([]);
  });

  it("moves the tape nowcast with IDR503's measured motion, in IDR503's pixels", async () => {
    const { store } = await started({ validFlows: true });
    const pair = store.getPair("IDR504", NEWEST + 10 * MIN)!;
    expect(pair.motionFrom).toBe("IDR503");
    expect(pair.motion.sx).toBeCloseTo(1, 12); // the fakes give every range the same geometry
    expect(pair.forecastLeadMs).toBe(10 * MIN);
    expect(pair.fromMs).toBe(NEWEST);
    expect(pair.toMs).toBe(NEWEST);
    expect(store.getPair("IDR503", NEWEST + 10 * MIN)!.motionFrom).toBe("IDR503");
  });

  it("uses the range's own motion until IDR503's flows arrive", async () => {
    const f = fakes({ gatedFlows: true, validFlows: true });
    store = new FrameStore(f.deps);
    void store.start();
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(29));
    await settle();
    expect(label(f.flow.mock.calls[0]![0])).toMatch(/^IDR504\//);
    f.gate.shift()!(); // only IDR504's newest pair gets its flow
    await settle();
    expect(store.getPair("IDR504", NEWEST + 10 * MIN)!.motionFrom).toBe("IDR504");
    await releaseAll(f.gate);
    expect(store.getPair("IDR504", NEWEST + 10 * MIN)!.motionFrom).toBe("IDR503");
  });

  it("falls back to the range's own motion when IDR503's flows measured nothing", async () => {
    const { store } = await started(); // zero flows without a `valid` mask: the 503 forecast is empty
    const pair = store.getPair("IDR504", NEWEST + 10 * MIN)!;
    expect(pair.motionFrom).toBe("IDR504");
    expect(pair.motion).toEqual({ sx: 1, ox: 0, sy: 1, oy: 0 });
  });

  it("does not take motion from a range whose flows matched no rain at all", async () => {
    const { store } = await started({ validFlows: "dry" }); // every range's mask is empty
    expect(store.getPair("IDR504", NEWEST + 10 * MIN)!.motionFrom).toBe("IDR504");
  });

  it("keeps IDR503's last measured motion while its newest frame's flow is still computing", async () => {
    const f = fakes({ gatedFlows: true, validFlows: true });
    store = new FrameStore(f.deps);
    void store.start();
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(29));
    await releaseAll(f.gate);
    expect(store.getPair("IDR504", NEWEST + 10 * MIN)!.motionFrom).toBe("IDR503");
    const next = NEWEST + STEP; // IDR503 publishes a new frame; its flow is held at the gate
    f.state.manifest.IDR503 = stampsBetween(next - 24 * H, next);
    f.state.now = next + MIN;
    await store.refresh();
    await settle();
    expect(f.gate.length).toBeGreaterThan(0);
    expect(store.getPair("IDR504", NEWEST + 10 * MIN)!.motionFrom).toBe("IDR503");
  });

  it("stops using a motion source whose newest frame is more than MAX_FLOW_GAP_MS behind", async () => {
    const stale = stampsBetween(NEWEST - 24 * H, NEWEST - 20 * MIN); // IDR503 stalled 20 min ago
    const { store } = await started({ validFlows: true, manifest: { IDR503: stale } });
    expect(store.getPair("IDR504", NEWEST + 10 * MIN)!.motionFrom).toBe("IDR504");
  });

  it("a past pair carries its two stamps and the identity motion", async () => {
    const { store } = await started();
    const pair = store.getPair("IDR504", NEWEST - 2.5 * MIN)!;
    expect(pair.fromMs).toBe(NEWEST - STEP);
    expect(pair.toMs).toBe(NEWEST);
    expect(pair.motionFrom).toBe("IDR504");
    expect(pair.motion).toEqual({ sx: 1, ox: 0, sy: 1, oy: 0 });
  });
});

describe("FrameStore needed ranges", () => {
  it("setNeeded loads an outer range for OUTER_DECODED_CAP_MS around the centre, shifted to end at the newest", async () => {
    const { api, store } = await started();
    api.fetchFrame.mockClear();
    store.setNeeded(["IDR502"]);
    await store.idle();
    const calls = frameCalls(api);
    expect(calls).toHaveLength(OUTER_DECODED_CAP_MS / STEP + 1); // live: the centre is the newest, so the whole 2 h
    for (const c of calls) {
      expect(c.p).toBe("IDR502");
      expect(NEWEST - c.ms).toBeLessThanOrEqual(OUTER_DECODED_CAP_MS);
    }
  });

  it("a range no longer needed stops loading but keeps its decoded frames under the budget", async () => {
    const { api, state, store } = await started();
    store.setNeeded(["IDR502"]);
    await store.idle();
    const count = () => api.fetchFrame.mock.calls.filter(([p]) => p === "IDR502").length;
    const n = count();
    const kept = store.decoded("IDR502");
    expect(kept.length).toBeGreaterThan(0);
    store.setNeeded([]);
    state.newest.marburg = NEWEST + STEP; // a new stamp it would load if it were still needed
    state.now = NEWEST + STEP + MIN;
    await store.refresh();
    await store.idle();
    expect(count()).toBe(n);
    expect(store.decoded("IDR502")).toEqual(kept);
  });

  it("flows go tape focus pair, then support newest pairs, then other needed ranges' focus pairs", async () => {
    const f = fakes({ gatedFlows: true });
    store = new FrameStore(f.deps);
    store.setNeeded(["IDR502"]);
    void store.start();
    await vi.waitFor(() => expect(f.flow).toHaveBeenCalledTimes(1));
    for (let k = 0; k < 4; k++) {
      await settle();
      f.gate.shift()!();
    }
    await settle();
    const pair = (p: ProductId, back: number) =>
      [`${p}/${msToStamp(NEWEST - (back + 1) * STEP)}`, `${p}/${msToStamp(NEWEST - back * STEP)}`];
    expect(f.flow.mock.calls.slice(0, 5).map(pairLabel)).toEqual([
      pair("IDR504", 0), pair("IDR503", 0), pair("IDR503", 1), pair("IDR503", 2), pair("IDR502", 0),
    ]);
  });
});

describe("FrameStore products and radar switching", () => {
  it("setNeeded lazy-loads another range of the active radar, and ignores other radars", async () => {
    const { api, store } = await started();
    api.fetchFrame.mockClear();
    store.setNeeded(["IDR663", "IDR502"]);
    await store.idle();
    const calls = frameCalls(api);
    expect(new Set(calls.map((c) => c.p))).toEqual(new Set(["IDR502"]));
    expect(calls).toHaveLength(OUTER_DECODED_CAP_MS / STEP + 1); // the last 2 h, live
    expect(store.getPair("IDR502", NEWEST - MIN)).not.toBeNull();
    expect(store.frames("IDR663")).toEqual([]);
  });

  it("setNeeded promotes a support range to the outer window", async () => {
    const { api, store } = await started();
    api.fetchFrame.mockClear();
    store.setNeeded(["IDR503"]);
    await store.idle();
    expect(frameCalls(api)).toHaveLength(25 - 4); // the 4 it already holds are not fetched again
    expect(store.decoded("IDR503")).toHaveLength(25);
  });

  it("uses Stapylton when Marburg is stale, then switches the whole store back", async () => {
    const stale = NEWEST - 25 * MIN;
    const { api, state, store } = await started({ newest: { marburg: stale } });
    expect(store.radar).toBe("stapylton");
    expect(new Set(frameCalls(api).map((c) => c.p))).toEqual(new Set(["IDR663", "IDR662"]));
    expect(store.tapeProducts()).toEqual(["IDR663", "IDR662"]);
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
