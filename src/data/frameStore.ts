import {
  CELL_SIZE, DEFAULT_WINDOW_MS, MANIFEST_SPAN_MS, NOWCAST_MAX_MS, RADARS, type CellSize, type ProductId,
} from "../../shared/config";
import type { LevelField } from "../../shared/decodeFrame";
import { msToStamp, stampToMs } from "../../shared/stamps";
import type { Manifest, RadarGeometry } from "../../shared/types";
import { FORECAST_PAIRS, forecastFlow, type FlowField } from "../motion/flow";
import { locate } from "../time/timeline";
import { chooseRadar, type RadarName } from "./chooseRadar";

/** Decoded frames + flows kept per product: a window this long around the playhead (spec §6.4). */
export const DECODED_CAP_MS = 21_600_000;
/** Manifest poll interval while the page is visible. */
export const REFRESH_MS = 60_000;
/** Frame fetch+decode jobs in flight at once. */
const MAX_CONCURRENT = 6;

export type FrameStoreDeps = {
  api: {
    fetchManifest(p: ProductId): Promise<Manifest>;
    fetchFrame(p: ProductId, stamp: string): Promise<Uint8Array>;
    fetchMeta(p: ProductId): Promise<RadarGeometry>;
    fetchDay(p: ProductId, day: string): Promise<string[]>;
    fetchEarliest(p: ProductId): Promise<string | null>;
  };
  decode(png: Uint8Array): LevelField;
  flow(a: LevelField, b: LevelField, gapMs: number): Promise<FlowField>;
  now(): number;
};

/**
 * What the layer draws at time t. `cell` is the product's native cell size (`CELL_SIZE[p]`),
 * included so CPU samplers (Task 12's tape) don't have to look it up; `RadarLayer` takes the same
 * value from the geometry itself.
 * Past the newest frame it is the nowcast: `forecastLeadMs` > 0, a = b = the newest frame, `flow` is
 * the forecast flow (px per ms, `forecastFlow`) and alpha is 0.
 */
export type FramePair = {
  a: LevelField; b: LevelField; flow: FlowField; alpha: number; cell: CellSize; forecastLeadMs?: number;
};

type ProductState = {
  p: ProductId;
  /** Every known stamp (ms), ascending and unique. Tiny, so never evicted. */
  pool: number[];
  /** Every stamp at or after this is in `pool` (Infinity until the manifest arrives). */
  coveredFrom: number;
  /** Day listings, fetched once per UTC day (`YYYYMMDD`). Failed requests are dropped and retried. */
  days: Map<string, Promise<string[]>>;
  /**
   * The archive floor: the earliest stamp the server has (`fetchEarliest`), learned once and only when
   * scroll-back first needs a day listing. Null inside the promise = the product has no frames.
   * A failed request is dropped and retried.
   */
  earliest: Promise<number | null> | null;
  decoded: Map<number, LevelField>;
  loading: Set<number>;
  /** Frames whose fetch/decode failed since the last refresh (not retried until then). */
  failed: Set<number>;
  /** Flow keyed by the earlier frame; valid only while `b` is still the next known stamp. */
  flows: Map<number, { b: number; flow: FlowField }>;
  /** Earlier stamps of pairs whose flow request failed since the last refresh (not retried until then). */
  flowFailed: Set<number>;
  framesCache: number[] | null;
  /**
   * The nowcast base: the newest frame, its field and the forecast flow from `pairs` pair flows. Kept
   * (holding its field) even if the decode window moves away, so the nowcast stays available.
   */
  forecast: { newest: number; a: LevelField; pairs: number; flow: FlowField } | null;
};

const dayOf = (ms: number) => msToStamp(ms).slice(0, 8);
const dayStartMs = (day: string) => stampToMs(`${day}0000`);

/** Index of `x` in ascending `arr`, or -1. */
function indexOf(arr: number[], x: number): number {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid]!;
    if (v === x) return mid;
    if (v < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Browser-side frame store for one radar at a time (spec §6.4, §7.5, §7.6).
 *
 * - **Radar:** each refresh picks the radar with `chooseRadar` from both radars' tape-product
 *   manifests. When it changes, the whole store switches: every product, decoded frame, flow and day
 *   listing of the old radar is dropped (radars are never mixed). The requested time range and the
 *   playhead focus carry over.
 * - **Known stamps** come from each product's manifest (last 24 h) and, further back, from
 *   `fetchDay`, one UTC day at a time, newest first, down to the server's earliest stamp
 *   (`fetchEarliest`). Empty days inside the archive (outages) are crossed, not taken as its end.
 *   `frames(p)` exposes the known stamps from the requested start (`extendBack`; initially
 *   newest − 2 h) to the newest.
 * - **Decoding** is limited to a window of `DECODED_CAP_MS` centred on the focus: the last
 *   `ensureAround(t)`, or the newest frame after `ensureAround(null)` (live, the default). The window
 *   is shifted to stay inside the requested range. Frames and flows outside it are evicted; frames load
 *   nearest-to-focus first. So `extendBack` far into the past learns the stamps but only decodes what
 *   falls in that window; `ensureAround` loads the rest.
 * - **Flows:** the store owns the queue. A pair is wanted while both frames are decoded, adjacent and
 *   flowless; one flow is computed at a time, always the wanted pair nearest the focus, chosen when it
 *   is sent, so nothing stale is ever sent and no evicted frame is held by a queue. A returned flow is
 *   kept if both stamps are still decoded and adjacent (stamps are immutable, so it is still valid).
 * - Dispatches `"change"` (coalesced per microtask) whenever anything observable changes.
 */
export class FrameStore extends EventTarget {
  radar: RadarName | null = null;
  status: "ok" | "stale" | "empty" = "empty";
  newestMs: number | null = null;

  private readonly deps: FrameStoreDeps;
  private gen = 0;
  private products = new Map<ProductId, ProductState>();
  private metas = new Map<ProductId, RadarGeometry>();
  private metaLoading = new Set<ProductId>();
  private lastTape: { marburg: Manifest | null; stapylton: Manifest | null } = { marburg: null, stapylton: null };
  private wantStart: number | null = null;
  private focus: number | null = null;
  private queue: { ps: ProductState; ms: number }[] = [];
  private running = 0;
  /** The one flow being computed, if any. */
  private flowInFlight = false;
  private pending = new Set<Promise<unknown>>();
  private refreshing: Promise<void> | null = null;
  private stopped = false;
  private changeQueued = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onVisibility = () => {
    if (document.visibilityState === "visible") void this.refresh();
  };

  constructor(deps: FrameStoreDeps) {
    super();
    this.deps = deps;
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /** First load, then refresh every 60 s and whenever the page becomes visible again. */
  async start(): Promise<void> {
    this.stopped = false;
    if (this.timer === null) {
      this.timer = setInterval(() => {
        if (typeof document === "undefined" || document.visibilityState !== "hidden") void this.refresh();
      }, REFRESH_MS);
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
    }
    await this.refresh();
    await this.idle();
  }

  /** Stops polling and abandons queued loads (in-flight results are discarded). */
  stop(): void {
    this.stopped = true;
    this.gen++;
    this.queue = [];
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
  }

  /** Resolves once no fetch, decode, flow or listing is in flight (tests and tooling). */
  async idle(): Promise<void> {
    for (;;) {
      if (this.pending.size === 0) {
        if (this.queue.length === 0) return;
        this.pump();
        if (this.pending.size === 0) return;
      }
      await Promise.allSettled([...this.pending]);
    }
  }

  // ---- public API ------------------------------------------------------------------------------

  /** Re-reads the manifests: may switch radar, learns new stamps and loads their frames. */
  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.track(this.doRefresh()).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /** Starts loading another range of the active radar (no-op for the other radar's products). */
  ensureProduct(p: ProductId): void {
    if (!this.radar || !RADARS[this.radar].products.includes(p) || this.products.has(p)) return;
    if (this.status === "empty") return;
    const ps = this.newProduct(p);
    this.track(this.syncProduct(ps, this.gen));
  }

  /** Learns every loaded product's stamps back to `toMs` (manifest, then `fetchDay`), then loads them. */
  extendBack(toMs: number): void {
    if (this.wantStart === null) return;
    if (toMs < this.wantStart) {
      this.wantStart = toMs;
      this.invalidateFrames();
      this.emit();
    }
    const g = this.gen;
    for (const ps of this.products.values()) {
      this.track(this.learn(ps, this.wantStart, g).then(() => this.schedule()));
    }
    this.schedule();
  }

  /**
   * Moves the decode window to `DECODED_CAP_MS` centred on `t`, evicting the furthest frames.
   * `null` means live: the window follows the newest frame as new ones arrive (the initial state).
   * Callers must pass null whenever the playhead is live, or the window stays pinned to an old `t`.
   */
  ensureAround(t: number | null): void {
    this.focus = t;
    this.schedule();
  }

  /**
   * The pair to draw at `t`, or null if it isn't decoded yet. Before the product's first frame it is
   * clamped to it; past its newest frame it is the nowcast (lead clamped to NOWCAST_MAX_MS).
   */
  getPair(p: ProductId, t: number): FramePair | null {
    const ps = this.products.get(p);
    if (!ps) return null;
    const fr = this.frames(p);
    if (fr.length < 2) return null;
    const newest = fr[fr.length - 1]!;
    if (t > newest) {
      const fc = this.forecastOf(ps, fr);
      if (!fc) return null;
      const forecastLeadMs = Math.min(t - newest, NOWCAST_MAX_MS);
      return { a: fc.a, b: fc.a, flow: fc.flow, alpha: 0, cell: CELL_SIZE[p], forecastLeadMs };
    }
    const { i, alpha } = locate(fr, t);
    const am = fr[i]!, bm = fr[i + 1]!;
    const a = ps.decoded.get(am), b = ps.decoded.get(bm), f = ps.flows.get(am);
    if (!a || !b || !f || f.b !== bm) return null;
    return { a, b, flow: f.flow, alpha, cell: CELL_SIZE[p] };
  }

  /** Known stamps (ms, ascending) from the requested start to the newest. Don't mutate. */
  frames(p: ProductId): number[] {
    const ps = this.products.get(p);
    if (!ps || this.wantStart === null) return [];
    if (!ps.framesCache) {
      const from = this.wantStart;
      let k = 0;
      while (k < ps.pool.length && ps.pool[k]! < from) k++;
      ps.framesCache = ps.pool.slice(k);
    }
    return ps.framesCache;
  }

  /** Earliest known stamp to the newest, over the loaded products. */
  loadedWindow(): { start: number; end: number } {
    let start = Infinity, end = -Infinity;
    for (const p of this.products.keys()) {
      const fr = this.frames(p);
      if (fr.length === 0) continue;
      start = Math.min(start, fr[0]!);
      end = Math.max(end, fr[fr.length - 1]!);
    }
    if (start === Infinity) {
      const t = this.newestMs ?? this.deps.now();
      return { start: t, end: t };
    }
    return { start, end };
  }

  /** Stamps currently decoded for `p` (ms, ascending). */
  decoded(p: ProductId): number[] {
    const ps = this.products.get(p);
    return ps ? [...ps.decoded.keys()].sort((x, y) => x - y) : [];
  }

  /** Geometries of the active radar's ranges that have loaded, widest to sharpest (for `pickRange`). */
  geometries(): RadarGeometry[] {
    if (!this.radar) return [];
    return RADARS[this.radar].products.flatMap((p) => this.metas.get(p) ?? []);
  }

  geometry(p: ProductId): RadarGeometry | null {
    return this.metas.get(p) ?? null;
  }

  /** The map's first range for a radar: 128 km (IDR503 / IDR663). */
  static startProduct(radar: RadarName): ProductId {
    return RADARS[radar].products[2]!;
  }

  // ---- refresh / radar choice ------------------------------------------------------------------

  private async doRefresh(): Promise<void> {
    const { api, now } = this.deps;
    const get = (p: ProductId) => api.fetchManifest(p).catch((e: unknown) => {
      console.warn(`manifest ${p} failed`, e);
      return null;
    });
    const [mb, st] = await Promise.all([get(RADARS.marburg.tapeProduct), get(RADARS.stapylton.tapeProduct)]);
    if (this.stopped) return;
    // A failed fetch keeps the last manifest, so one network blip doesn't switch radar.
    this.lastTape = { marburg: mb ?? this.lastTape.marburg, stapylton: st ?? this.lastTape.stapylton };
    const choice = chooseRadar(this.lastTape, now());

    if (choice.radar !== this.radar) this.switchRadar(choice.radar);
    const g = this.gen;
    this.status = choice.status;
    this.newestMs = choice.newestMs;
    this.emit();
    if (choice.newestMs === null) return;

    const floor = choice.newestMs - DEFAULT_WINDOW_MS;
    if (this.wantStart === null || floor < this.wantStart) {
      this.wantStart = floor;
      this.invalidateFrames();
    }
    const radar = choice.radar;
    this.ensureMetas(radar);
    if (this.products.size === 0) {
      for (const p of new Set([FrameStore.startProduct(radar), RADARS[radar].tapeProduct])) this.newProduct(p);
    }
    const tape = RADARS[radar].tapeProduct;
    const tapeManifest = radar === "marburg" ? mb : st;
    const all = [...this.products.values()];
    // Merge every product's manifest before scheduling, so loads go newest-first across products
    // (the map's newest pair comes first, not the whole tape product).
    const ms = await Promise.all(all.map((ps) => (ps.p === tape && tapeManifest ? tapeManifest : this.manifestOf(ps.p))));
    if (g !== this.gen) return;
    all.forEach((ps, k) => {
      ps.failed.clear();
      ps.flowFailed.clear();
      this.applyManifest(ps, ms[k] ?? null);
    });
    this.schedule();
    await Promise.all(all.map((ps) => this.learnAndSchedule(ps, g)));
  }

  private switchRadar(radar: RadarName): void {
    this.gen++;
    this.radar = radar;
    this.products.clear();
    this.queue = [];
    this.invalidateFrames();
  }

  private ensureMetas(radar: RadarName): void {
    for (const p of RADARS[radar].products) {
      if (this.metas.has(p) || this.metaLoading.has(p)) continue;
      this.metaLoading.add(p);
      this.track(
        this.deps.api.fetchMeta(p).then(
          (g) => {
            this.metas.set(p, g);
            this.emit();
          },
          (e: unknown) => console.warn(`meta ${p} failed`, e),
        ).finally(() => this.metaLoading.delete(p)),
      );
    }
  }

  // ---- stamps ----------------------------------------------------------------------------------

  private newProduct(p: ProductId): ProductState {
    const ps: ProductState = {
      p, pool: [], coveredFrom: Infinity, days: new Map(), earliest: null,
      decoded: new Map(), loading: new Set(), failed: new Set(), flows: new Map(), flowFailed: new Set(),
      framesCache: null, forecast: null,
    };
    this.products.set(p, ps);
    return ps;
  }

  private manifestOf(p: ProductId): Promise<Manifest | null> {
    return this.deps.api.fetchManifest(p).catch((e: unknown) => {
      console.warn(`manifest ${p} failed`, e);
      return null;
    });
  }

  /**
   * A manifest lists every stamp of the last MANIFEST_SPAN_MS (its contract, whatever builds it), so
   * the pool is complete from `now − MANIFEST_SPAN_MS` (or from its first stamp, if earlier).
   */
  private applyManifest(ps: ProductState, m: Manifest | null): void {
    if (!m) return;
    const ms = m.frames.map(stampToMs);
    this.merge(ps, ms);
    ps.coveredFrom = Math.min(ps.coveredFrom, ms[0] ?? Infinity, this.deps.now() - MANIFEST_SPAN_MS);
  }

  private async learnAndSchedule(ps: ProductState, g: number): Promise<void> {
    if (this.wantStart !== null && ps.coveredFrom !== Infinity) await this.learn(ps, this.wantStart, g);
    if (g === this.gen) this.schedule();
  }

  /** Fetch and merge one product's manifest, learn back to the requested start, schedule. */
  private async syncProduct(ps: ProductState, g: number): Promise<void> {
    const m = await this.manifestOf(ps.p);
    if (g !== this.gen) return;
    this.applyManifest(ps, m);
    this.schedule();
    await this.learnAndSchedule(ps, g);
  }

  private merge(ps: ProductState, ms: number[]): void {
    const set = new Set(ps.pool);
    let added = false;
    for (const x of ms) if (!set.has(x)) { set.add(x); added = true; }
    if (!added) return;
    ps.pool = [...set].sort((x, y) => x - y);
    ps.framesCache = null;
    this.emit();
  }

  /**
   * The product's archive floor (ms; null = no frames), fetched once. Undefined if the request failed
   * (it is retried on the next call).
   */
  private async earliestOf(ps: ProductState): Promise<number | null | undefined> {
    if (!ps.earliest) {
      const req = this.deps.api.fetchEarliest(ps.p).then((s) => (s ? stampToMs(s) : null));
      ps.earliest = req;
      req.catch(() => {
        if (ps.earliest === req) ps.earliest = null;
      });
    }
    try {
      return await ps.earliest;
    } catch (e) {
      console.warn(`earliest ${ps.p} failed`, e);
      return undefined;
    }
  }

  /**
   * Make `ps.pool` complete back to `toMs` with day listings, one UTC day at a time, newest first,
   * bounded by the server's earliest stamp. Each day is requested once (the promise is cached;
   * concurrent callers share it). An empty day inside the archive (an outage) is simply crossed.
   */
  private async learn(ps: ProductState, toMs: number, g: number): Promise<void> {
    while (ps.coveredFrom > toMs && ps.coveredFrom !== Infinity) {
      const earliest = await this.earliestOf(ps);
      if (g !== this.gen || earliest === undefined) return;
      if (earliest === null || ps.coveredFrom <= earliest) return; // reached the start of the archive
      const day = dayOf(ps.coveredFrom - 1);
      let req = ps.days.get(day);
      if (!req) {
        req = this.deps.api.fetchDay(ps.p, day);
        ps.days.set(day, req);
        req.catch(() => ps.days.delete(day));
      }
      let stamps: string[];
      try {
        stamps = await req;
      } catch (e) {
        console.warn(`day ${ps.p}/${day} failed`, e);
        return;
      }
      if (g !== this.gen) return;
      if (stamps.length) this.merge(ps, stamps.map(stampToMs));
      ps.coveredFrom = Math.min(ps.coveredFrom, dayStartMs(day));
    }
  }

  // ---- decode window ---------------------------------------------------------------------------

  /** The decode window: DECODED_CAP_MS around the focus, kept inside [requested start, newest]. */
  private window(): { start: number; end: number; centre: number } | null {
    if (this.wantStart === null) return null;
    let hi = -Infinity;
    for (const ps of this.products.values()) if (ps.pool.length) hi = Math.max(hi, ps.pool[ps.pool.length - 1]!);
    if (hi === -Infinity) {
      if (this.newestMs === null) return null;
      hi = this.newestMs;
    }
    const lo = Math.min(this.wantStart, hi);
    const centre = Math.min(Math.max(this.focus ?? hi, lo), hi);
    if (hi - lo <= DECODED_CAP_MS) return { start: lo, end: hi, centre };
    let start = centre - DECODED_CAP_MS / 2;
    let end = centre + DECODED_CAP_MS / 2;
    if (end > hi) { start -= end - hi; end = hi; }
    if (start < lo) { end += lo - start; start = lo; }
    return { start, end, centre };
  }

  /** Evict outside the window, queue missing frames nearest-first, then send the next wanted flow. */
  private schedule(): void {
    const w = this.window();
    if (!w) return;
    const inside = (ms: number) => ms >= w.start && ms <= w.end;
    const jobs: { ps: ProductState; ms: number; d: number; order: number }[] = [];
    let order = 0;
    for (const ps of this.products.values()) {
      for (const ms of ps.decoded.keys()) if (!inside(ms)) ps.decoded.delete(ms);
      for (const [a, f] of ps.flows) {
        if (!ps.decoded.has(a) || !ps.decoded.has(f.b) || this.nextOf(ps, a) !== f.b) ps.flows.delete(a);
      }
      for (const ms of this.frames(ps.p)) {
        if (!inside(ms) || ps.decoded.has(ms) || ps.loading.has(ms) || ps.failed.has(ms)) continue;
        jobs.push({ ps, ms, d: Math.abs(ms - w.centre), order: order++ });
      }
    }
    jobs.sort((x, y) => x.d - y.d || x.order - y.order);
    this.queue = jobs.map(({ ps, ms }) => ({ ps, ms }));
    this.pump();
    this.pumpFlows();
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.running < MAX_CONCURRENT && this.queue.length > 0) {
      const { ps, ms } = this.queue.shift()!;
      if (ps.decoded.has(ms) || ps.loading.has(ms) || this.products.get(ps.p) !== ps) continue;
      this.track(this.load(ps, ms, this.gen));
    }
  }

  private async load(ps: ProductState, ms: number, g: number): Promise<void> {
    ps.loading.add(ms);
    this.running++;
    try {
      const png = await this.deps.api.fetchFrame(ps.p, msToStamp(ms));
      if (g !== this.gen) return;
      const w = this.window();
      if (!w || ms < w.start || ms > w.end) return; // the window moved on while it loaded
      ps.decoded.set(ms, this.deps.decode(png));
      this.emit();
      this.pumpFlows();
    } catch (e) {
      ps.failed.add(ms);
      console.warn(`frame ${ps.p}/${msToStamp(ms)} failed`, e);
    } finally {
      ps.loading.delete(ms);
      this.running--;
      this.pump();
    }
  }

  private nextOf(ps: ProductState, ms: number): number | undefined {
    const k = indexOf(ps.pool, ms);
    return k >= 0 ? ps.pool[k + 1] : undefined;
  }

  /**
   * The wanted pair nearest the focus: adjacent known stamps, both decoded, no flow yet (and no failed
   * request since the last refresh). Chosen fresh each time, so the "queue" is never stale.
   */
  private nextWantedFlow(): { ps: ProductState; am: number; bm: number } | null {
    const w = this.window();
    if (!w) return null;
    let best: { ps: ProductState; am: number; bm: number; d: number } | null = null;
    for (const ps of this.products.values()) {
      if (ps.decoded.size < 2) continue;
      const fr = this.frames(ps.p);
      for (let k = 0; k + 1 < fr.length; k++) {
        const am = fr[k]!, bm = fr[k + 1]!;
        if (!ps.decoded.has(am) || !ps.decoded.has(bm)) continue;
        if (ps.flows.get(am)?.b === bm || ps.flowFailed.has(am)) continue;
        const d = Math.abs((am + bm) / 2 - w.centre);
        if (!best || d < best.d) best = { ps, am, bm, d };
      }
    }
    return best;
  }

  /** Send the next wanted flow, one at a time. Called whenever frames, flows or the window change. */
  private pumpFlows(): void {
    if (this.stopped || this.flowInFlight) return;
    const next = this.nextWantedFlow();
    if (!next) return;
    const { ps, am, bm } = next;
    const g = this.gen;
    this.flowInFlight = true;
    this.track(
      this.deps.flow(ps.decoded.get(am)!, ps.decoded.get(bm)!, bm - am).then(
        (flow) => {
          if (g !== this.gen) return;
          // Stamps are immutable, so the flow is valid while both are decoded and still adjacent, even if
          // a frame was evicted and decoded again meanwhile. Otherwise drop it; if the pair is decoded
          // again later it is simply wanted again.
          if (!ps.decoded.has(am) || !ps.decoded.has(bm) || this.nextOf(ps, am) !== bm) return;
          ps.flows.set(am, { b: bm, flow });
          this.emit();
        },
        (e: unknown) => {
          ps.flowFailed.add(am);
          console.warn("flow failed", e);
        },
      ).finally(() => {
        this.flowInFlight = false;
        this.pumpFlows();
      }),
    );
  }

  /**
   * The nowcast base for the newest frame, from the flows of the last FORECAST_PAIRS adjacent pairs
   * (newest first, stopping at the first missing one). Recomputed when the newest frame changes or more
   * of those flows have arrived; null until the newest frame and the newest pair's flow are there.
   */
  private forecastOf(ps: ProductState, fr: number[]): ProductState["forecast"] {
    const n = fr.length, newest = fr[n - 1]!;
    const flows: FlowField[] = [], gaps: number[] = [];
    for (let k = n - 2; k >= Math.max(0, n - 1 - FORECAST_PAIRS); k--) {
      const f = ps.flows.get(fr[k]!);
      if (!f || f.b !== fr[k + 1]) break;
      flows.unshift(f.flow);
      gaps.unshift(fr[k + 1]! - fr[k]!);
    }
    const a = ps.decoded.get(newest);
    const c = ps.forecast;
    if (c && c.newest === newest && (c.pairs >= flows.length || !a)) return c;
    if (!a || flows.length === 0) return null;
    ps.forecast = { newest, a, pairs: flows.length, flow: forecastFlow(flows, gaps) };
    return ps.forecast;
  }


  // ---- plumbing --------------------------------------------------------------------------------

  private invalidateFrames(): void {
    for (const ps of this.products.values()) ps.framesCache = null;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    p.then(() => this.pending.delete(p), () => this.pending.delete(p));
    return p;
  }

  private emit(): void {
    if (this.changeQueued) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      this.dispatchEvent(new Event("change"));
    });
  }
}
