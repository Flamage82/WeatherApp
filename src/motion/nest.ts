import type { CellSize } from "../../shared/config";
import type { LevelField } from "../../shared/decodeFrame";
import type { PixelAffine } from "../../shared/gnomonic";
import { flowAt, type FlowField } from "./flow";
import { bilinear, forecastOpacity } from "./interpolate";

/**
 * A kept pair counts as data only while the drawn time is within one frame interval of it (spec §4.3).
 */
export const KEPT_TOLERANCE_MS = 300_000;

/**
 * BOM's frames carry no data in their outer 16 px (pixels 0-15 and 496-511): measured on IDR502, 503 and
 * 504, the share of non-zero pixels steps up at exactly 16 px from the edge. A range's coverage is the
 * 480 px square inside that border, so a finer range never hides a coarser one's rain behind blank.
 */
export const DATA_MARGIN_PX = 16;

/** Pixels inside the frame's data area's nearest edge, measured from pixel edges; negative outside. */
export function edgeDist(x: number, y: number): number {
  const lo = DATA_MARGIN_PX - 0.5, hi = 511.5 - DATA_MARGIN_PX;
  return Math.min(x - lo, hi - x, y - lo, hi - y);
}

/** 0 outside the frame; across the band a smoothstep from the edge to full weight; band 0 is a hard edge. */
export function edgeWeight(d: number, band: number): number {
  if (d < 0) return 0;
  if (band === 0) return 1;
  const t = Math.min(1, Math.max(0, d / band));
  return t * t * (3 - 2 * t);
}

/**
 * One range of the nest. `leadMs > 0` means nowcast: `a` is the newest frame, `flow` is the motion field
 * in the *motion* grid's px/ms, and `motion` maps this slot's px to the motion grid's px.
 * Otherwise `a` and `b` are the pair and `flow` is its A->B displacement in this slot's px.
 */
export type NestSlot = {
  a: LevelField; b: LevelField; flow: FlowField; alpha: number; leadMs: number;
  cell: CellSize; band: number; motion: PixelAffine; fresh: boolean;
};

/**
 * THE nested-range formula (the shader's `nestSlot` reproduces exactly this): the level this slot shows
 * at its own pixel (x, y) and its weight. The weight is the smallest edge weight over the point and the
 * source point(s) it reads, so a range that would read from outside its frame gives way to a coarser one.
 */
export function nestSlotSample(s: NestSlot, x: number, y: number): { level: number; weight: number } {
  let w = edgeWeight(edgeDist(x, y), s.band);
  if (w <= 0) return { level: 0, weight: 0 };
  if (s.leadMs > 0) {
    const [vx, vy] = flowAt(s.flow, s.motion.sx * x + s.motion.ox, s.motion.sy * y + s.motion.oy);
    const sx = x - (s.leadMs * vx) / s.motion.sx, sy = y - (s.leadMs * vy) / s.motion.sy;
    w = Math.min(w, edgeWeight(edgeDist(sx, sy), s.band));
    return { level: bilinear(s.a, sx, sy, s.cell), weight: w };
  }
  const [fx, fy] = flowAt(s.flow, x, y);
  const ax = x - s.alpha * fx, ay = y - s.alpha * fy, bx = x + (1 - s.alpha) * fx, by = y + (1 - s.alpha) * fy;
  w = Math.min(w, edgeWeight(edgeDist(ax, ay), s.band), edgeWeight(edgeDist(bx, by), s.band));
  const wa = bilinear(s.a, ax, ay, s.cell), wb = bilinear(s.b, bx, by, s.cell);
  return { level: Math.min((1 - s.alpha) * wa + s.alpha * wb, Math.max(wa, wb)), weight: w };
}

/**
 * Combine slots, finest first; `ps[i]` is the point in slot i's px. Fresh slots blend by weight:
 * c = rem·w, level = Σ c·L, opacity = Σ c·forecastOpacity(lead) / Σ c, rem *= 1 − w. Where no fresh slot
 * has data, the finest stale one is drawn so scrubbing into undecoded frames never blanks the map.
 * Null where nothing covers the point.
 */
export function sampleNested(
  slots: NestSlot[], ps: { x: number; y: number }[],
): { level: number; opacity: number } | null {
  let rem = 1, level = 0, opSum = 0, cSum = 0;
  let stale: { level: number; opacity: number } | null = null;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!;
    const { level: l, weight: w } = nestSlotSample(s, ps[i]!.x, ps[i]!.y);
    if (w <= 0) continue;
    const op = forecastOpacity(s.leadMs);
    if (!s.fresh) {
      stale ??= { level: l, opacity: op };
      continue;
    }
    const c = rem * w;
    level += c * l;
    opSum += c * op;
    cSum += c;
    rem *= 1 - w;
    if (rem <= 0) break;
  }
  if (cSum > 0) return { level, opacity: opSum / cSum };
  return stale;
}

export function isFresh(pair: { fromMs: number; toMs: number }, t: number): boolean {
  return pair.fromMs - KEPT_TOLERANCE_MS <= t && t <= pair.toMs + KEPT_TOLERANCE_MS;
}
