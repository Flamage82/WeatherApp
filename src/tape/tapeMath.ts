import { stampToMs } from "../../shared/stamps";

/** Tape span: 40 min by default (±20 min around the playhead), zoomable from 20 min to 7 days (spec §6.2). */
export const DEFAULT_SPAN_MS = 2_400_000;
export const MIN_SPAN_MS = 1_200_000;
export const MAX_SPAN_MS = 604_800_000;
/** Above this span the graph uses the server's per-frame series instead of the interpolated one. */
export const SERIES_SOURCE_SWITCH_MS = 10_800_000;
/** Step of the interpolated home series. */
export const SERIES_STEP_MS = 30_000;

/** A column with no point inside takes the nearest point's level if it's at most this far away. */
const NEAREST_MS = 600_000;
const MIN = 60_000, H = 3_600_000;
const TICK_STEPS_MS = [10 * MIN, 30 * MIN, H, 3 * H, 6 * H, 12 * H, 24 * H];
const MAX_LABELS = 6;
const FLING_HALF_LIFE_MS = 250;
/** Fling stop threshold (ms per ms) at the default span; callers scale it with the span. */
export const FLING_MIN_V = 0.05;

/** Tape time covered by a drag of `dxPx` across a `widthPx` tape (dragging right goes back: callers negate). */
export function pxToMs(dxPx: number, widthPx: number, spanMs: number): number {
  return (dxPx / widthPx) * spanMs;
}

/** The span after zooming by `scale` (a pinch spreading 2x gives 2), clamped to [MIN_SPAN_MS, MAX_SPAN_MS]. */
export function zoomSpan(spanMs: number, scale: number): number {
  return Math.min(MAX_SPAN_MS, Math.max(MIN_SPAN_MS, spanMs / scale));
}

/** The first label step giving at most 6 labels across the span (1 day at most). */
export function tickStepMs(spanMs: number): number {
  return TICK_STEPS_MS.find((s) => spanMs / s <= MAX_LABELS) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1]!;
}

/** Fling velocity after `dtMs` of exponential friction (half-life 250 ms); 0 once below `minV`. */
export function flingStep(v: number, dtMs: number, minV = FLING_MIN_V): number {
  const next = v * 0.5 ** (dtMs / FLING_HALF_LIFE_MS);
  return Math.abs(next) < minV ? 0 : next;
}

/**
 * Per-column level over [fromMs, toMs] from ascending per-frame points. Columns are half-open
 * [start, end), except the last, which includes `toMs`. A column takes the max of the points inside
 * it; with none inside, the nearest point's level if within 10 min of the column centre, else NaN.
 */
export function seriesToColumns(
  points: [stamp: string, level: number][], fromMs: number, toMs: number, columns: number,
): Float32Array {
  const out = new Float32Array(columns).fill(NaN);
  const ms = points.map(([s]) => stampToMs(s));
  const w = (toMs - fromMs) / columns;
  let k = 0; // first point not before the current column's start
  while (k < ms.length && ms[k]! < fromMs) k++;
  for (let c = 0; c < columns; c++) {
    const end = fromMs + (c + 1) * w;
    const inside = c === columns - 1 ? (x: number) => x <= toMs : (x: number) => x < end;
    let j = k, max = -Infinity;
    for (; j < ms.length && inside(ms[j]!); j++) max = Math.max(max, points[j]![1]);
    if (j > k) {
      out[c] = max;
    } else {
      const centre = fromMs + (c + 0.5) * w;
      let best = NEAREST_MS;
      for (const i of [k - 1, k]) {
        const d = i >= 0 && i < ms.length ? Math.abs(ms[i]! - centre) : Infinity;
        if (d <= best) { best = d; out[c] = points[i]![1]; }
      }
    }
    k = j;
  }
  return out;
}
