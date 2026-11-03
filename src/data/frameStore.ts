import {
  CELL_SIZE, DEFAULT_WINDOW_MS, MANIFEST_SPAN_MS, MAX_FLOW_GAP_MS, NOWCAST_MAX_MS, NOWCAST_MOTION, RADARS,
  type CellSize, type ProductId,
} from "../../shared/config";
import type { LevelField } from "../../shared/decodeFrame";
import { IDENTITY_AFFINE, pixelAffine, type PixelAffine } from "../../shared/gnomonic";
import { msToStamp, stampToMs } from "../../shared/stamps";
import type { LatLon, Manifest, RadarGeometry } from "../../shared/types";
import { nearestRadar } from "../location/location";
import { FORECAST_PAIRS, forecastFlow, type FlowField } from "../motion/flow";
import { locate } from "../time/timeline";
import { chooseRadar, type RadarName } from "./chooseRadar";
import { chooseTapeProduct } from "./tapeProduct";

/** Decoded frames + flows kept for the tape product: a window this long around the playhead (spec §6.4). */
export const DECODED_CAP_MS = 21_600_000;
/**
 * The decode window of a needed range other than the tape product: this long, centred on the focus
 * and cut to the known stamps (nested-ranges spec §5).
 */
export const OUTER_DECODED_CAP_MS = 7_200_000;
/**
 * Decoded frames held in total (~46 MB) before ranges that are no longer needed lose theirs, furthest
 * from the focus first (nested-ranges spec §5).
 */
export const DECODED_BUDGET_FRAMES = 180;
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
  /** The initial location; `setLocation` moves it. `override` is a radar chosen by hand, if any. */
  location: { point: LatLon; override: RadarName | null };
};

/**
 * What the layer draws at time t. `cell` is the product's native cell size (`CELL_SIZE[p]`),
 * included so CPU samplers (Task 12's tape) don't have to look it up; `RadarLayer` takes the same
 * value from the geometry itself.
 * Past the newest frame it is the nowcast: `forecastLeadMs` > 0, a = b = the newest frame, `flow` is
 * the forecast flow (px per ms, `forecastFlow`) and alpha is 0.
 * `fromMs`/`toMs` are the stamps of a and b (both the newest frame's in the nowcast), so a drawn pair
 * can tell how stale it is (`isFresh`). `flow` of a nowcast is in the grid of `motionFrom`: usually the
 * range's own (identity `motion`), or the nowcast-motion range's (spec §4.4), with `motion` mapping this
 * range's pixels onto that grid's.
 */
export type FramePair = {
  a: LevelField; b: LevelField; flow: FlowField; alpha: number; cell: CellSize; forecastLeadMs?: number;
  fromMs: number; toMs: number; motion: PixelAffine; motionFrom: ProductId;
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
  forecast: { newest: number; a: LevelField; pairs: number; flow: FlowField; measured: boolean } | null;
};

type Span = { start: number; end: number };
/** Scheduling priority: tier, then two keys, smallest first (see `ranker`). */
type Rank = [number, number, number];
const byRank = (x: Rank, y: Rank) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
const within = (spans: Span[], ms: number) => spans.some((s) => ms >= s.start && ms <= s.end);

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
 * - **Location and radar:** each refresh picks the radar with `chooseRadar` from both radars' check-product
 *   manifests, preferring the one nearer the location (or the one chosen by hand, `setLocation`). When it
 *   changes, the whole store switches: every product, decoded frame, flow and day listing of the old radar
 *   is dropped (radars are never mixed). The requested time range and the playhead focus carry over.
 * - **Tape product:** the finest range of the radar whose frame holds the location's 1 km disc
 *   (`chooseTapeProduct`). The location, radar and tape product change together, at the end of a refresh,
 *   so what a reader sees (`location`, `radar`, `tapeProduct`) is always one consistent set. A location
 *   set while a refresh runs gets a second refresh straight after it.
 * - **Known stamps** come from each product's manifest (last 24 h) and, further back, from
 *   `fetchDay`, one UTC day at a time, newest first, down to the server's earliest stamp
 *   (`fetchEarliest`). Empty days inside the archive (outages) are crossed, not taken as its end.
 *   `frames(p)` exposes the known stamps from the requested start (`extendBack`; initially
 *   newest − 2 h) to the newest.
 * - **Decoding** is limited to a window per product around the focus: the last `ensureAround(t)`, or
 *   the newest frame after `ensureAround(null)` (live, the default). The tape product's is
 *   `DECODED_CAP_MS`, shifted to stay inside the requested range; the other ranges the view needs
 *   (`setNeeded`) get `OUTER_DECODED_CAP_MS` centred on the focus; the nowcast support ranges always
 *   keep their newest `FORECAST_PAIRS + 1` frames. Frames and flows outside an active product's window
 *   are evicted. A range no longer needed keeps what it decoded until the total passes
 *   `DECODED_BUDGET_FRAMES`. So `extendBack` far into the past learns the stamps but only decodes what
 *   falls in the windows; `ensureAround` loads the rest.
 * - **Priority** (frames and flows alike): the tape product's pair at the focus, then the support
 *   ranges' newest frames and pairs, then the other needed ranges' pairs at the focus (finest first),
 *   then everything else nearest the focus, finer ranges on ties (nested-ranges spec §5).
 * - **Flows:** the store owns the queue. A pair is wanted while both frames are decoded, adjacent and
 *   flowless; one flow is computed at a time, always the wanted pair of highest priority, chosen when it
 *   is sent, so nothing stale is ever sent and no evicted frame is held by a queue. A returned flow is
 *   kept if both stamps are still decoded and adjacent (stamps are immutable, so it is still valid).
 * - Dispatches `"change"` (coalesced per microtask) whenever anything observable changes.
 */
export class FrameStore extends EventTarget {
  radar: RadarName | null = null;
  status: "ok" | "stale" | "empty" = "empty";
  newestMs: number | null = null;
  /** True while the radar in use isn't the preferred one (the preferred one was stale, the other fresh). */
  fallback = false;

  private readonly deps: FrameStoreDeps;
  private gen = 0;
  private products = new Map<ProductId, ProductState>();
  private metas = new Map<ProductId, RadarGeometry>();
  private metaLoading = new Map<ProductId, Promise<void>>();
  private lastCheck: { marburg: Manifest | null; stapylton: Manifest | null } = { marburg: null, stapylton: null };
  /** The location asked for, and the one applied (with `radar` and `tapeProd`) by the last refresh. */
  private wanted: LatLon;
  private point: LatLon;
  private override: RadarName | null;
  private tapeProd: ProductId | null = null;
  private locationChanged = false;
  private affines = new Map<string, PixelAffine>();
  /**
   * Ranges the view needs (`setNeeded`), beyond the tape product and its nowcast support. Kept as given
   * (it may be set before a radar is chosen); products of another radar are ignored where it is read.
   */
  private needed = new Set<ProductId>();
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
    this.wanted = this.point = deps.location.point;
    this.override = deps.location.override;
  }

  /** The location the tape and the hint read: the one applied by the last refresh. */
  get location(): LatLon {
    return this.point;
  }

  /** The tape product, or null before a radar is chosen. */
  get tapeProduct(): ProductId | null {
    return this.tapeProd;
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
      this.refreshing = this.track(this.refreshWhileChanged()).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /**
   * Moves the location (and the radar chosen by hand, or null for the nearer one) and refreshes. If a
   * refresh is already running, one more runs straight after it, so the final state is the last call's.
   */
  setLocation(point: LatLon, override: RadarName | null): void {
    this.wanted = point;
    this.override = override;
    this.locationChanged = true;
    this.emit();
    void this.refresh();
  }

  private async refreshWhileChanged(): Promise<void> {
    do {
      this.locationChanged = false;
      await this.doRefresh();
    } while (this.locationChanged && !this.stopped);
  }

  /**
   * The ranges the view needs beyond the tape product (any order; the other radar's products are
   * ignored). A new one is created and synced; one already held (a support range, or one needed before)
   * learns its stamps back to the requested start. A range dropped from the list stops loading and
   * keeps its decoded frames until the budget needs them. May be called before a radar is chosen: the
   * list is applied at the first refresh.
   */
  setNeeded(ps: ProductId[]): void {
    const before = this.needed;
    this.needed = new Set(ps);
    if (!this.radar || this.wantStart === null) return; // the next refresh creates them
    const g = this.gen;
    for (const p of this.needed) {
      if (!RADARS[this.radar].products.includes(p)) continue;
      const have = this.products.get(p);
      if (!have) this.track(this.syncProduct(this.newProduct(p), g));
      else if (!before.has(p)) this.track(this.learnAndSchedule(have, g));
    }
    this.schedule();
  }

  /**
   * The ranges the tape and the rain hint read, finest first: the tape product, then its nowcast
   * support: the range whose motion moves it (`NOWCAST_MOTION`) and the next coarser range, which
   * supplies the rain from outside the tape range's frame (spec §5, §6). Empty before a radar is chosen.
   */
  tapeProducts(): ProductId[] {
    return this.radar && this.tapeProd ? this.tapeSet() : [];
  }

  private tapeSet(): ProductId[] {
    const tape = this.tapeProd!;
    const { products } = RADARS[this.radar!];
    const coarser = products[products.indexOf(tape) - 1];
    return [...new Set([tape, NOWCAST_MOTION[tape], ...(coarser ? [coarser] : [])])];
  }

  private isTape(p: ProductId): boolean {
    return p === this.tapeProd;
  }

  /** A nowcast support range (not the tape product): its newest frames are always kept. */
  private isSupport(p: ProductId): boolean {
    return !this.isTape(p) && this.tapeSet().includes(p);
  }

  /** The tape product or a needed range: its stamps are learnt back to the requested start. */
  private learnsBack(p: ProductId): boolean {
    return this.isTape(p) || this.needed.has(p);
  }

  /**
   * The decode window of one product, as spans, given the tape product's window `w`. Empty: inactive
   * (no loads, no flows; what it holds is evicted only by the budget).
   */
  private windowFor(ps: ProductState, w: { start: number; end: number; centre: number; lo: number; hi: number }): Span[] {
    if (this.isTape(ps.p)) return [w];
    const spans: Span[] = [];
    if (this.needed.has(ps.p)) {
      // Shifted to stay inside [lo, hi] like the tape window, so live it is the newest OUTER_DECODED_CAP_MS.
      let start = w.centre - OUTER_DECODED_CAP_MS / 2, end = w.centre + OUTER_DECODED_CAP_MS / 2;
      if (end > w.hi) { start -= end - w.hi; end = w.hi; }
      if (start < w.lo) { end = Math.min(w.hi, end + (w.lo - start)); start = w.lo; }
      spans.push({ start, end });
    }
    const fr = this.frames(ps.p);
    if (this.isSupport(ps.p) && fr.length > 0) {
      spans.push({ start: fr[Math.max(0, fr.length - 1 - FORECAST_PAIRS)]!, end: fr[fr.length - 1]! });
    }
    return spans;
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
      if (!this.learnsBack(ps.p)) continue; // support-only or inactive: it never needs older frames
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
      const { flow, motion, motionFrom } = this.nowcastMotion(p, fc);
      return {
        a: fc.a, b: fc.a, flow, alpha: 0, cell: CELL_SIZE[p], forecastLeadMs,
        fromMs: newest, toMs: newest, motion, motionFrom,
      };
    }
    const { i, alpha } = locate(fr, t);
    const am = fr[i]!, bm = fr[i + 1]!;
    const a = ps.decoded.get(am), b = ps.decoded.get(bm), f = ps.flows.get(am);
    if (!a || !b || !f || f.b !== bm) return null;
    return { a, b, flow: f.flow, alpha, cell: CELL_SIZE[p], fromMs: am, toMs: bm, motion: IDENTITY_AFFINE, motionFrom: p };
  }

  /**
   * The motion that moves `p`'s nowcast: its `NOWCAST_MOTION` range's forecast flow when that is measured
   * and both geometries are loaded (spec §4.4), else `p`'s own (start-up, or a frame gap left the
   * source with zero flows), so the nowcast never freezes. While the source's newest frame is still being
   * fetched or its flow computed, its last forecast keeps moving the nowcast, so the motion doesn't flip to
   * `p`'s own and back each time the source publishes; but a source more than MAX_FLOW_GAP_MS behind `p`
   * (one product stalled) is not used.
   */
  private nowcastMotion(p: ProductId, own: NonNullable<ProductState["forecast"]>) {
    const src = NOWCAST_MOTION[p];
    const sps = this.products.get(src);
    const gp = this.metas.get(p), gs = this.metas.get(src);
    if (src !== p && sps && gp && gs && this.frames(src).length >= 2) {
      const fc = this.forecastOf(sps, this.frames(src)) ?? sps.forecast;
      if (fc?.measured && own.newest - fc.newest <= MAX_FLOW_GAP_MS) {
        const key = `${p}>${src}`;
        let motion = this.affines.get(key);
        if (!motion) this.affines.set(key, (motion = pixelAffine(gp, gs)));
        return { flow: fc.flow, motion, motionFrom: src };
      }
    }
    return { flow: own.flow, motion: IDENTITY_AFFINE, motionFrom: p };
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

  /**
   * Earliest known stamp to the newest, from the tape product when it has frames ("now" is the tape
   * product's newest, spec §5.1), else over the loaded products.
   */
  loadedWindow(): { start: number; end: number } {
    let start = Infinity, end = -Infinity;
    const tape = this.tapeProd;
    const ps = tape && this.frames(tape).length > 0 ? [tape] : [...this.products.keys()];
    for (const p of ps) {
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

  /** Geometries of the active radar's ranges that have loaded, widest to sharpest (for `neededRanges`, which wants them reversed). */
  geometries(): RadarGeometry[] {
    if (!this.radar) return [];
    return RADARS[this.radar].products.flatMap((p) => this.metas.get(p) ?? []);
  }

  geometry(p: ProductId): RadarGeometry | null {
    return this.metas.get(p) ?? null;
  }

  // ---- refresh / radar choice ------------------------------------------------------------------

  private async doRefresh(): Promise<void> {
    const { api, now } = this.deps;
    const point = this.wanted, override = this.override;
    const get = (p: ProductId) => api.fetchManifest(p).catch((e: unknown) => {
      console.warn(`manifest ${p} failed`, e);
      return null;
    });
    const [mb, st] = await Promise.all([get(RADARS.marburg.checkProduct), get(RADARS.stapylton.checkProduct)]);
    if (this.stopped) return;
    // A failed fetch keeps the last manifest, so one network blip doesn't switch radar.
    this.lastCheck = { marburg: mb ?? this.lastCheck.marburg, stapylton: st ?? this.lastCheck.stapylton };
    const choice = chooseRadar(this.lastCheck, now(), { radar: override ?? nearestRadar(point), manual: override !== null });

    if (choice.radar !== this.radar) this.switchRadar(choice.radar);
    this.point = point;
    this.retarget();
    const g = this.gen;
    this.fallback = choice.fallback;
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
    // The tape product is picked from real geometry, so wait for the radar's metas before creating products.
    await this.ensureMetas(radar);
    if (g !== this.gen) return;
    this.retarget();
    for (const p of [...this.tapeSet(), ...this.needed]) {
      if (RADARS[radar].products.includes(p) && !this.products.has(p)) this.newProduct(p);
    }
    const checkProduct = RADARS[radar].checkProduct;
    const checkManifest = radar === "marburg" ? mb : st;
    const all = [...this.products.values()];
    // Merge every product's manifest before scheduling, so loads go newest-first across products
    // (the map's newest pair comes first, not the whole tape product).
    const ms = await Promise.all(all.map((ps) => (ps.p === checkProduct && checkManifest ? checkManifest : this.manifestOf(ps.p))));
    if (g !== this.gen) return;
    all.forEach((ps, k) => {
      ps.failed.clear();
      ps.flowFailed.clear();
      this.applyManifest(ps, ms[k] ?? null);
    });
    this.schedule();
    await Promise.all(all.map((ps) => this.learnAndSchedule(ps, g)));
  }

  /** The tape product for the applied location on the active radar, from the geometries loaded so far. */
  private retarget(): void {
    const next = this.radar ? chooseTapeProduct(this.radar, this.point, (p) => this.metas.get(p) ?? null) : null;
    if (next === this.tapeProd) return;
    this.tapeProd = next;
    this.emit();
  }

  private switchRadar(radar: RadarName): void {
    this.gen++;
    this.radar = radar;
    this.products.clear();
    this.queue = [];
    this.invalidateFrames();
  }

  /** Starts every missing geometry of the radar. Resolves once they have all settled (a failed one is retried next refresh). */
  private async ensureMetas(radar: RadarName): Promise<void> {
    const loading: Promise<void>[] = [];
    for (const p of RADARS[radar].products) {
      if (this.metas.has(p)) continue;
      let req = this.metaLoading.get(p);
      if (!req) {
        req = this.track(
          this.deps.api.fetchMeta(p).then(
            (g) => {
              this.metas.set(p, g);
              this.emit();
            },
            (e: unknown) => console.warn(`meta ${p} failed`, e),
          ).finally(() => this.metaLoading.delete(p)),
        );
        this.metaLoading.set(p, req);
      }
      loading.push(req);
    }
    await Promise.all(loading);
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
    if (this.wantStart !== null && ps.coveredFrom !== Infinity && this.learnsBack(ps.p)) {
      await this.learn(ps, this.wantStart, g);
    }
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

  /**
   * The tape product's decode window: DECODED_CAP_MS around the focus, kept inside [requested start,
   * newest] = [lo, hi]. `centre` is the focus clamped into [lo, hi]; every product's window and
   * priority is taken around it.
   */
  private window(): { start: number; end: number; centre: number; lo: number; hi: number } | null {
    if (this.wantStart === null) return null;
    let hi = -Infinity;
    for (const ps of this.products.values()) if (ps.pool.length) hi = Math.max(hi, ps.pool[ps.pool.length - 1]!);
    if (hi === -Infinity) {
      if (this.newestMs === null) return null;
      hi = this.newestMs;
    }
    const lo = Math.min(this.wantStart, hi);
    const centre = Math.min(Math.max(this.focus ?? hi, lo), hi);
    if (hi - lo <= DECODED_CAP_MS) return { start: lo, end: hi, centre, lo, hi };
    let start = centre - DECODED_CAP_MS / 2;
    let end = centre + DECODED_CAP_MS / 2;
    if (end > hi) { start -= end - hi; end = hi; }
    if (start < lo) { end += lo - start; start = lo; }
    return { start, end, centre, lo, hi };
  }

  /**
   * The priority of one product's frames and pairs around `centre` (nested-ranges spec §5), as
   * [tier, key, key], smallest first:
   * - 0: the tape product's focus pair (the stamps either side of the centre, clamped to its frames,
   *   so its newest pair when the centre is past them);
   * - 1: a support range's newest `FORECAST_PAIRS + 1` frames / newest pairs, finest first, newest first;
   * - 2: another needed range's focus pair, finest first;
   * - 3: everything else, nearest the centre first, finer range on ties.
   */
  private ranker(ps: ProductState, centre: number) {
    const { products } = RADARS[this.radar!];
    const fine = products.length - 1 - products.indexOf(ps.p); // 0 = finest
    const fr = this.frames(ps.p);
    const tape = this.isTape(ps.p), support = this.isSupport(ps.p), needed = this.needed.has(ps.p);
    const k = fr.length > 0 ? locate(fr, centre).i : -1;
    const fa = fr[k], fb = fr[k + 1];
    const newestFrom = fr[Math.max(0, fr.length - 1 - FORECAST_PAIRS)] ?? Infinity;
    const far = (ms: number) => Math.abs(ms - centre);
    return {
      frame: (ms: number): Rank => {
        const focus = ms === fa || ms === fb;
        if (tape && focus) return [0, far(ms), 0];
        if (support && ms >= newestFrom) return [1, fine, -ms];
        if (needed && focus) return [2, fine, far(ms)];
        return [3, far(ms), fine];
      },
      pair: (am: number, bm: number): Rank => {
        const focus = am === fa && bm === fb;
        if (tape && focus) return [0, 0, 0];
        if (support && am >= newestFrom) return [1, fine, -am];
        if (needed && focus) return [2, fine, 0];
        return [3, far((am + bm) / 2), fine];
      },
    };
  }

  /**
   * Evict outside each active product's window (and inactive products' frames past the budget), queue
   * missing frames by priority, then send the next wanted flow.
   */
  private schedule(): void {
    const w = this.window();
    if (!w) return;
    const jobs: { ps: ProductState; ms: number; rank: Rank }[] = [];
    const idle: { ps: ProductState; ms: number }[] = [];
    let total = 0;
    for (const ps of this.products.values()) {
      const spans = this.windowFor(ps, w);
      if (spans.length === 0) {
        for (const ms of ps.decoded.keys()) idle.push({ ps, ms });
      } else {
        for (const ms of ps.decoded.keys()) if (!within(spans, ms)) ps.decoded.delete(ms);
        const rank = this.ranker(ps, w.centre);
        for (const ms of this.frames(ps.p)) {
          if (!within(spans, ms) || ps.decoded.has(ms) || ps.loading.has(ms) || ps.failed.has(ms)) continue;
          jobs.push({ ps, ms, rank: rank.frame(ms) });
        }
      }
      total += ps.decoded.size;
    }
    if (total > DECODED_BUDGET_FRAMES) {
      // Inactive ranges give their frames back, furthest from the centre first.
      idle.sort((x, y) => Math.abs(y.ms - w.centre) - Math.abs(x.ms - w.centre));
      for (const { ps, ms } of idle) {
        if (total <= DECODED_BUDGET_FRAMES) break;
        ps.decoded.delete(ms);
        total--;
      }
    }
    for (const ps of this.products.values()) {
      for (const [a, f] of ps.flows) {
        if (!ps.decoded.has(a) || !ps.decoded.has(f.b) || this.nextOf(ps, a) !== f.b) ps.flows.delete(a);
      }
    }
    jobs.sort((x, y) => byRank(x.rank, y.rank));
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
      if (!w || !within(this.windowFor(ps, w), ms)) return; // the window moved on while it loaded
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
   * The wanted pair of highest priority (`ranker`): adjacent known stamps of an active product, both
   * decoded, no flow yet (and no failed request since the last refresh). Chosen fresh each time, so the
   * "queue" is never stale.
   */
  private nextWantedFlow(): { ps: ProductState; am: number; bm: number } | null {
    const w = this.window();
    if (!w) return null;
    let best: { ps: ProductState; am: number; bm: number; rank: Rank } | null = null;
    for (const ps of this.products.values()) {
      if (ps.decoded.size < 2 || this.windowFor(ps, w).length === 0) continue; // inactive: no flows
      const fr = this.frames(ps.p);
      const ranker = this.ranker(ps, w.centre);
      for (let k = 0; k + 1 < fr.length; k++) {
        const am = fr[k]!, bm = fr[k + 1]!;
        if (!ps.decoded.has(am) || !ps.decoded.has(bm)) continue;
        if (ps.flows.get(am)?.b === bm || ps.flowFailed.has(am)) continue;
        const rank = ranker.pair(am, bm);
        if (!best || byRank(rank, best.rank) < 0) best = { ps, am, bm, rank };
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
    ps.forecast = {
      newest, a, pairs: flows.length, flow: forecastFlow(flows, gaps), measured: flows.some((f) => f.valid?.includes(1)),
    };
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
