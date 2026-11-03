import { NOWCAST_MAX_MS } from "../../shared/config";
import { flowAt, type FlowField } from "./flow";

/** Backward-advection step, about one frame gap. */
export const NOWCAST_STEP_MS = 300_000;
/** Forecast time over which the motion eases from the detailed field to the large-scale one. */
export const RELAX_MS = 3_600_000;
/** Steps in the longest nowcast. Both copies stop here, so a lead past NOWCAST_MAX_MS goes no further. */
export const MAX_NOWCAST_STEPS = Math.ceil(NOWCAST_MAX_MS / NOWCAST_STEP_MS);

/**
 * The nowcast motion at motion-grid point (x, y), `tauMs` past the newest frame, in motion px per ms:
 * the detailed field at "now" easing linearly to the large-scale one by RELAX_MS, since small swirls don't
 * outlast the first hour but the steering flow does. Without `large` the two are the same.
 */
export function nowcastVelocity(v: FlowField, x: number, y: number, tauMs: number): [number, number] {
  const [lx, ly] = flowAt(v, x, y);
  const [gx, gy] = flowAt(v, x, y, v.large ?? v.data);
  const r = Math.min(1, Math.max(0, tauMs / RELAX_MS));
  return [lx + (gx - lx) * r, ly + (gy - ly) * r];
}

/**
 * THE nowcast formula (the shader's `nestSlot` reproduces exactly this, step for step): the source point,
 * in motion px, of the rain that is at motion px (qx, qy) `leadMs` after the newest frame. It walks back
 * in NOWCAST_STEP_MS midpoint (RK2) steps: the motion at the step's mid-time, read at the point a half
 * step along the motion at the current point. Paths that follow a smooth field can't cross, so the
 * mapping doesn't fold; and the image is read once, at the end, so the forecast is as sharp as a real
 * frame. The midpoint step, not a plain Euler one, because real flow fields change by up to a step's
 * length between neighbouring cells, and an Euler step then folds the mapping.
 */
export function advectBack(v: FlowField, qx: number, qy: number, leadMs: number): [number, number] {
  let tau = leadMs;
  for (let k = 0; k < MAX_NOWCAST_STEPS && tau > 0; k++) {
    const h = Math.min(NOWCAST_STEP_MS, tau), tm = tau - h / 2;
    const [ux, uy] = nowcastVelocity(v, qx, qy, tm);
    const [vx, vy] = nowcastVelocity(v, qx - 0.5 * h * ux, qy - 0.5 * h * uy, tm);
    qx -= h * vx; qy -= h * vy; tau -= h;
  }
  return [qx, qy];
}

/**
 * How much the nowcast mapping p -> s distorts the picture at `leadMs`, over a grid of motion px
 * (default 16..496, step 16). `det J` of the mapping's Jacobian: <= 0 is a fold, far above 1 is squeezing;
 * `maxStretch` is the largest ratio of its principal stretches, far above 1 is streaking.
 * `singleJump` measures the old formula, s = p - lead*V(p), for before/after numbers.
 */
export function nowcastDeformation(
  v: FlowField, leadMs: number,
  opts: { singleJump?: boolean; from?: number; to?: number; step?: number } = {},
): { minDet: number; maxDet: number; maxStretch: number } {
  const { singleJump = false, from = 16, to = 496, step = 16 } = opts;
  const map = (x: number, y: number): [number, number] => {
    if (!singleJump) return advectBack(v, x, y, leadMs);
    const [vx, vy] = flowAt(v, x, y);
    return [x - leadMs * vx, y - leadMs * vy];
  };
  let minDet = Infinity, maxDet = -Infinity, maxStretch = 0;
  for (let y = from; y <= to; y += step)
    for (let x = from; x <= to; x += step) {
      const [xp, yp] = map(x + 1, y), [xm, ym] = map(x - 1, y);
      const [xu, yu] = map(x, y + 1), [xd, yd] = map(x, y - 1);
      const a = (xp - xm) / 2, b = (xu - xd) / 2, c = (yp - ym) / 2, d = (yu - yd) / 2;
      const det = a * d - b * c;
      const f2 = a * a + b * b + c * c + d * d;
      const root = Math.sqrt(Math.max(0, f2 * f2 - 4 * det * det));
      const s1 = (f2 + root) / 2, s2 = (f2 - root) / 2;
      minDet = Math.min(minDet, det);
      maxDet = Math.max(maxDet, det);
      maxStretch = Math.max(maxStretch, s2 > 0 ? Math.sqrt(s1 / s2) : Infinity);
    }
  return { minDet, maxDet, maxStretch };
}
