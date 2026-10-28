import { useEffect, useRef } from "react";
import { NOWCAST_MAX_MS, RADARS, type ProductId } from "../../shared/config";
import { msToStamp } from "../../shared/stamps";
import type { SeriesDay } from "../../shared/types";
import { fetchSeries } from "../data/api";
import type { FrameStore } from "../data/frameStore";
import { forecastOpacity } from "../motion/interpolate";
import { MAX_LEVEL, rampColour } from "../render/colourRamp";
import { buildHomeForecast, buildHomeSeries } from "./homeSeries";
import {
  DEFAULT_SPAN_MS, SERIES_SOURCE_SWITCH_MS, SERIES_STEP_MS,
  flingStep, pxToMs, seriesToColumns, tickStepMs, zoomSpan,
} from "./tapeMath";

export const TAPE_HEIGHT = 64;
/** Bottom strip of the tape that holds the time labels. */
const LABEL_H = 18;
/** Release velocity is measured over the last this-many ms of moves. */
const VELOCITY_WINDOW_MS = 80;
const DOUBLE_TAP_MS = 300;
/** A press that moves less than this is a tap. */
const TAP_SLOP_PX = 8;
/** A fling stops once it moves less than this per frame. */
const FLING_STOP_PX = 0.5;
const FRAME_MS = 1000 / 60;
/** Brisbane is UTC+10 all year (no DST), so label ticks align on local midnight with a fixed offset. */
const BRISBANE_OFFSET_MS = 36_000_000;
const DAY_MS = 86_400_000;
/** Cached series days refetched when a new frame arrives: the newest frame's day, and the day before it for this long. */
const DAY_SETTLE_MS = 7_200_000;
/** A failed series day is retried after this. */
const SERIES_RETRY_MS = 30_000;
const HATCH_PX = 6;
/** Background of the nowcast section: a cool violet, distinct from the past (the tape's panel is dark in both themes). */
const FORECAST_TINT = "rgba(167,139,250,0.16)";

const fmtTime = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Brisbane", hour: "numeric", minute: "2-digit", hour12: true,
});
const fmtDate = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", weekday: "short", day: "numeric" });

/** Tick label: the date ("Tue 27") at midnight, date and time when the step is 6 h or more, else the time. */
function tickLabel(ms: number, stepMs: number): string {
  const time = fmtTime.format(ms).replace(":00", "");
  if ((ms + BRISBANE_OFFSET_MS) % DAY_MS === 0) return fmtDate.format(ms);
  return stepMs >= 21_600_000 ? `${fmtDate.format(ms)} ${time}` : time;
}

const dayOf = (ms: number) => msToStamp(ms).slice(0, 8);

type HomeSeries = { product: ProductId; fromMs: number; values: Float32Array };

/** Level at `tc` from a 30 s home series, linear between steps (NaN where either step is). */
function homeLevel(h: Pick<HomeSeries, "fromMs" | "values">, tc: number): number {
  const q = (tc - h.fromMs) / SERIES_STEP_MS, n = h.values.length;
  if (!(q >= 0 && q <= n - 1)) return NaN;
  if (n === 1) return h.values[0]!;
  const i = Math.min(Math.floor(q), n - 2);
  const a = h.values[i]!, b = h.values[i + 1]!;
  return a + (b - a) * (q - i);
}

type Props = {
  store: FrameStore;
  /** Playhead time (ms), drawn at the centre. */
  t: number;
  spanMs: number;
  /** Called with the new playhead time, already clamped to the loaded start .. the nowcast's end. */
  onScrub(tMs: number): void;
  onSpanChange(spanMs: number): void;
  /** True while the user drives the tape: a pointer is down, or a fling is coasting. */
  onGesture?(active: boolean): void;
};

/**
 * The tape (spec §6.2): a 64 px strip scrolling under a fixed centre playhead, drawing rain at home over
 * time in the map's colours. Drag (with fling) or wheel to scrub; pinch or Ctrl/⌘ + wheel to zoom about
 * the playhead; double-tap resets the span. Its source is the active radar's tape product, whatever the
 * map shows: up to 3 h of span the interpolated 30 s series from the decoded pairs (`buildHomeSeries`),
 * above that the server's per-frame series (`fetchSeries`, one UTC day file each, cached). Where neither
 * has a value yet the tape shows a faint hatch. Past the newest frame ("now") comes the nowcast, up to
 * NOWCAST_MAX_MS: a tinted section whose graph is the client nowcast at home (`buildHomeForecast`, at any
 * span), faded as the map fades it. Beyond that the tape is shaded.
 */
export function Tape({ store, t, spanMs, onScrub, onSpanChange, onGesture }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const props = useRef({ onScrub, onSpanChange, onGesture });
  props.current = { onScrub, onSpanChange, onGesture };
  // The tape's own view of time and span: updated at once by gestures, re-synced from props on render.
  const tRef = useRef(t);
  const spanRef = useRef(spanMs);
  const requestDraw = useRef(() => {});

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const hatch = makeHatch(ctx);
    let raf = 0;
    let home: HomeSeries | null = null;
    let homeDirty = true;
    /** Series points per `product/day`; null while the first fetch is in flight. */
    const days = new Map<string, SeriesDay["points"] | null>();
    const inFlight = new Set<string>();
    let lastNewest = store.newestMs;

    const tapeProduct = (): ProductId | null => (store.radar ? RADARS[store.radar].tapeProduct : null);

    function loadDay(p: ProductId, day: string): void {
      const key = `${p}/${day}`;
      if (inFlight.has(key)) return;
      inFlight.add(key);
      if (!days.has(key)) days.set(key, null);
      fetchSeries(p, day).then(
        (s) => {
          days.set(key, s.points);
          requestDraw.current();
        },
        (e: unknown) => {
          console.warn(`series ${key} failed`, e);
          if (days.get(key) === null) setTimeout(() => days.get(key) === null && days.delete(key), SERIES_RETRY_MS);
        },
      ).finally(() => inFlight.delete(key));
    }

    /** Points from the cached day files covering [fromMs, toMs]; starts fetching any day not cached yet. */
    function dayPoints(p: ProductId, fromMs: number, toMs: number): SeriesDay["points"] {
      const out: SeriesDay["points"] = [];
      for (let d = Math.floor(fromMs / DAY_MS) * DAY_MS; d <= toMs; d += DAY_MS) {
        const day = dayOf(d), pts = days.get(`${p}/${day}`);
        if (pts === undefined) loadDay(p, day);
        else if (pts) for (const x of pts) out.push(x);
      }
      return out;
    }

    function ensureHome(p: ProductId): void {
      if (!homeDirty && home?.product === p) return;
      homeDirty = false;
      const geom = store.geometry(p), dec = store.decoded(p);
      home = geom && dec.length >= 2
        ? { product: p, fromMs: dec[0]!, values: buildHomeSeries(store, p, geom, dec[0]!, dec[dec.length - 1]!) }
        : null;
    }

    function draw(): void {
      cancelAnimationFrame(raf);
      raf = 0;
      const w = canvas.clientWidth, h = TAPE_HEIGHT, dpr = window.devicePixelRatio || 1;
      if (!w) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const t = tRef.current, span = spanRef.current;
      const from = t - span / 2, to = t + span / 2;
      const end = store.loadedWindow().end, fcEnd = end + NOWCAST_MAX_MS;
      const xOf = (ms: number) => ((ms - from) / span) * w;
      const graphH = h - LABEL_H;
      const cols = Math.max(1, Math.round(w)), colW = w / cols, colMs = span / cols;
      const p = tapeProduct();
      // The tape product's own newest frame. It trails `end` when the map shows a finer range, which
      // publishes a couple of minutes ahead; the nowcast (built from this frame) fills that gap.
      const pFrames = p ? store.frames(p) : [];
      const dataEnd = pFrames.length ? pFrames[pFrames.length - 1]! : end;

      let levels: Float32Array = new Float32Array(cols).fill(NaN);
      if (p && span <= SERIES_SOURCE_SWITCH_MS) {
        ensureHome(p);
        if (home) for (let c = 0; c < cols; c++) levels[c] = homeLevel(home, from + (c + 0.5) * colMs);
      } else if (p) {
        levels = seriesToColumns(dayPoints(p, from - colMs, Math.min(to, end) + colMs), from, to, cols);
      }
      // Nowcast columns, at any span.
      const geom = p && to > dataEnd ? store.geometry(p) : null;
      const fc = p && geom ? buildHomeForecast(store, p, geom) : null;
      for (let c = 0; c < cols; c++) {
        const tc = from + (c + 0.5) * colMs;
        if (tc > dataEnd) levels[c] = fc ? homeLevel(fc, tc) : NaN;
      }

      // The nowcast section's tint, under the graph.
      if (end < to && fcEnd > from) {
        const x0 = Math.max(0, xOf(end)), x1 = Math.min(w, xOf(fcEnd));
        ctx.fillStyle = FORECAST_TINT;
        ctx.fillRect(x0, 0, x1 - x0, graphH);
      }

      // Graph, and a hatch (scrolling with the tape) where there's no value yet. Nothing after the nowcast.
      hatch?.setTransform(new DOMMatrix([1, 0, 0, 1, xOf(0) % HATCH_PX, 0]));
      let hatchFrom = -1;
      const flushHatch = (c: number) => {
        if (hatchFrom < 0 || !hatch) return;
        ctx.fillStyle = hatch;
        ctx.fillRect(hatchFrom * colW, 0, (c - hatchFrom) * colW, graphH);
        hatchFrom = -1;
      };
      for (let c = 0; c < cols; c++) {
        const tc = from + (c + 0.5) * colMs;
        if (tc > fcEnd) { flushHatch(c); break; }
        const v = levels[c]!;
        if (Number.isNaN(v)) {
          if (hatchFrom < 0) hatchFrom = c;
          continue;
        }
        flushHatch(c);
        if (v <= 0) continue;
        const [r, g, b, a] = rampColour(v);
        const bar = Math.max(1, (Math.min(v, MAX_LEVEL) / MAX_LEVEL) * graphH);
        const fade = tc > end ? forecastOpacity(tc - end) : 1;
        ctx.fillStyle = `rgba(${r},${g},${b},${(a / 255) * fade})`;
        ctx.fillRect(c * colW, graphH - bar, colW + 0.5, bar);
      }
      flushHatch(cols);

      // Beyond the nowcast there's no data: shaded. A line at "now".
      if (fcEnd < to) {
        const x = Math.max(0, xOf(fcEnd));
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(x, 0, w - x, h);
      }
      if (end >= from && end < to) {
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.fillRect(xOf(end), 0, 1, graphH);
      }

      // Ticks and labels on local (Brisbane) multiples of the step; a label that would overlap is skipped.
      const step = tickStepMs(span);
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      let lastRight = -Infinity;
      for (let tk = Math.ceil((from + BRISBANE_OFFSET_MS) / step) * step - BRISBANE_OFFSET_MS; tk <= to; tk += step) {
        const x = xOf(tk);
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fillRect(Math.round(x), graphH, 1, 4);
        const label = tickLabel(tk, step);
        const half = ctx.measureText(label).width / 2;
        if (x - half < lastRight + 6 || x - half < 2 || x + half > w - 2) continue;
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fillText(label, x, graphH + LABEL_H / 2 + 1);
        lastRight = x + half;
      }

      // The playhead.
      ctx.fillStyle = "#fff";
      ctx.fillRect(Math.round(w / 2) - 1, 0, 2, h);
    }
    requestDraw.current = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    const onChange = () => {
      homeDirty = true;
      // A new frame: refetch the cached series days it could have added to.
      if (store.newestMs !== lastNewest && store.newestMs !== null) {
        lastNewest = store.newestMs;
        const p = tapeProduct();
        if (p) {
          for (const day of new Set([dayOf(lastNewest), dayOf(lastNewest - DAY_SETTLE_MS)])) {
            if (days.get(`${p}/${day}`)) loadDay(p, day);
          }
        }
      }
      requestDraw.current();
    };
    store.addEventListener("change", onChange);
    const ro = new ResizeObserver(() => requestDraw.current());
    ro.observe(canvas);

    // ---- gestures -------------------------------------------------------------------------------

    const pointers = new Map<number, number>(); // pointerId -> clientX
    let lastX = 0;
    let samples: { at: number; t: number }[] = [];
    let pinch: { d0: number; span0: number } | null = null;
    let press: { x: number; at: number; moved: boolean } | null = null;
    let lastTap = -Infinity;
    let fling = 0;

    const scrubTo = (target: number): number => {
      const { start, end } = store.loadedWindow();
      const c = Math.min(Math.max(target, start), end + NOWCAST_MAX_MS);
      tRef.current = c;
      props.current.onScrub(c);
      requestDraw.current();
      return c;
    };
    const setSpan = (s: number) => {
      if (s === spanRef.current) return;
      spanRef.current = s;
      props.current.onSpanChange(s);
      requestDraw.current();
    };
    let active = false;
    const syncActive = () => {
      const a = pointers.size > 0 || fling !== 0;
      if (a !== active) props.current.onGesture?.((active = a));
    };
    const stopFling = () => {
      cancelAnimationFrame(fling);
      fling = 0;
      syncActive();
    };
    const startFling = (v0: number) => {
      let v = v0, last = performance.now();
      const step = (now: number) => {
        const dt = now - last;
        last = now;
        // Stop once it moves less than FLING_STOP_PX per (60 Hz) frame, so it doesn't creep on invisibly.
        v = flingStep(v, dt, (FLING_STOP_PX * spanRef.current) / (canvas.clientWidth * FRAME_MS));
        const target = tRef.current + v * dt;
        // Stop when friction wins or the tape hits either end of what's loaded.
        if (v === 0 || scrubTo(target) !== target) {
          fling = 0;
          syncActive();
        } else {
          fling = requestAnimationFrame(step);
        }
      };
      fling = requestAnimationFrame(step);
      syncActive();
    };
    const pinchDistance = () => {
      const [a, b] = [...pointers.values()];
      return Math.max(20, Math.abs(a! - b!));
    };

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      stopFling();
      pointers.set(e.pointerId, e.clientX);
      syncActive();
      if (pointers.size === 1) {
        lastX = e.clientX;
        samples = [{ at: e.timeStamp, t: tRef.current }];
        press = { x: e.clientX, at: e.timeStamp, moved: false };
      } else if (pointers.size === 2) {
        pinch = { d0: pinchDistance(), span0: spanRef.current };
        press = null;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, e.clientX);
      if (pinch) {
        if (pointers.size >= 2) setSpan(zoomSpan(pinch.span0, pinchDistance() / pinch.d0));
        return;
      }
      if (press && Math.abs(e.clientX - press.x) > TAP_SLOP_PX) press.moved = true;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      if (!dx) return;
      const tt = scrubTo(tRef.current - pxToMs(dx, canvas.clientWidth, spanRef.current));
      samples.push({ at: e.timeStamp, t: tt });
      while (samples.length > 2 && e.timeStamp - samples[0]!.at > VELOCITY_WINDOW_MS) samples.shift();
    };
    const onUp = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      release(e);
      syncActive();
    };
    /** A pointer went up (already removed from `pointers`): end a pinch, detect a double tap, or fling. */
    const release = (e: PointerEvent) => {
      if (pinch) {
        if (pointers.size < 2) pinch = null;
        if (pointers.size === 1) {
          // Back to dragging with the remaining finger, without a jump.
          lastX = [...pointers.values()][0]!;
          samples = [];
        }
        return;
      }
      if (pointers.size > 0) return;
      if (press && !press.moved && e.timeStamp - press.at < DOUBLE_TAP_MS) {
        if (e.timeStamp - lastTap < DOUBLE_TAP_MS) {
          lastTap = -Infinity;
          setSpan(DEFAULT_SPAN_MS);
        } else {
          lastTap = e.timeStamp;
        }
      }
      press = null;
      if (e.type === "pointercancel") return;
      const recent = samples.filter((s) => e.timeStamp - s.at <= VELOCITY_WINDOW_MS);
      if (recent.length >= 2) {
        const a = recent[0]!, b = recent[recent.length - 1]!;
        if (b.at > a.at) startFling((b.t - a.t) / (b.at - a.at));
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // no page zoom (Ctrl) or scroll
      stopFling();
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvas.clientWidth : 1;
      if (e.ctrlKey || e.metaKey) {
        setSpan(zoomSpan(spanRef.current, Math.exp((-e.deltaY * unit) / 300)));
      } else {
        const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
        scrubTo(tRef.current + pxToMs(d, canvas.clientWidth, spanRef.current));
      }
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      store.removeEventListener("change", onChange);
      ro.disconnect();
      cancelAnimationFrame(raf);
      stopFling();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      requestDraw.current = () => {};
    };
  }, [store]);

  useEffect(() => {
    tRef.current = t;
    spanRef.current = spanMs;
    requestDraw.current();
  }, [t, spanMs]);

  return (
    <canvas
      ref={canvasRef}
      aria-label="time tape"
      data-testid="tape"
      style={{ display: "block", width: "100%", height: TAPE_HEIGHT, touchAction: "none", userSelect: "none", cursor: "grab" }}
    />
  );
}

/** A faint diagonal hatch: "no value here yet". */
function makeHatch(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const c = document.createElement("canvas");
  c.width = c.height = HATCH_PX;
  const g = c.getContext("2d")!;
  g.strokeStyle = "rgba(255,255,255,0.16)";
  g.beginPath();
  g.moveTo(0, HATCH_PX);
  g.lineTo(HATCH_PX, 0);
  g.stroke();
  return ctx.createPattern(c, "repeat");
}
