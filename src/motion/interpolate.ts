import type { CellSize } from "../../shared/config";
import type { LevelField } from "../../shared/decodeFrame";
import { flowAt, type FlowField } from "./flow";

/**
 * Bilinear sample between native cell centres. BOM replicates each native k x k cell onto the 512
 * grid (`CELL_SIZE`, phase 0), so cell (cx, cy) covers pixels [k*cx, k*cx + k) and its value sits at
 * its centre, pixel coord k*cx + (k-1)/2. Interpolating between pixel values instead would give a
 * plateau-plus-ramp staircase. Cells outside the frame read 0.
 * With k = 1 this is plain per-pixel bilinear: pixel (ix, iy) has its value at (x = ix, y = iy).
 */
function bilinear(f: LevelField, x: number, y: number, k: CellSize): number {
  const n = 512 / k;
  // Cell coords q = (p + 0.5)/k - 0.5, written as (p - (k-1)/2)/k so k = 1 gives q = p exactly.
  const h = (k - 1) / 2;
  const qx = (x - h) / k, qy = (y - h) / k;
  const x0 = Math.floor(qx), y0 = Math.floor(qy);
  const tx = qx - x0, ty = qy - y0;
  const d = f.data;
  const g = (cx: number, cy: number) => (cx < 0 || cy < 0 || cx >= n || cy >= n ? 0 : d[cy * k * 512 + cx * k]!);
  return (
    (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) +
    (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty
  );
}

/**
 * Interpolated level at full-res pixel p = (x, y), blend position alpha in [0,1] (0 = A, 1 = B).
 * `cell` is the product's native cell size, `CELL_SIZE[product]`; it defaults to 1 (per-pixel)
 * only for synthetic fields, so real-frame callers must pass it.
 * THE formula (the radar layer's shader reproduces exactly this):
 *   F  = flowAt(f, x, y)                       (A->B displacement in px)
 *   wa = A(p - alpha*F)      wb = B(p + (1-alpha)*F)     (cell bilinear, out-of-bounds = 0)
 *   result = min((1-alpha)*wa + alpha*wb, max(wa, wb))
 */
export function sampleInterpolated(
  a: LevelField, b: LevelField, f: FlowField, alpha: number, x: number, y: number, cell: CellSize = 1,
): number {
  const [fx, fy] = flowAt(f, x, y);
  const wa = bilinear(a, x - alpha * fx, y - alpha * fy, cell);
  const wb = bilinear(b, x + (1 - alpha) * fx, y + (1 - alpha) * fy, cell);
  return Math.min((1 - alpha) * wa + alpha * wb, Math.max(wa, wb));
}

/**
 * Maximum sampleInterpolated over the native cell centres (pixel k*c + (k-1)/2) within radius rPx of
 * (cx, cy), cells inside the frame only: the same cells `maxLevelInDisc` reads, so at a frame's own time
 * (alpha 0, or 1 on B) both give the same value. With k = 1 the centres are the integer pixels.
 */
export function sampleInterpolatedMaxInDisc(
  a: LevelField, b: LevelField, f: FlowField, alpha: number, cx: number, cy: number, rPx: number,
  cell: CellSize = 1,
): number {
  let m = 0;
  const r2 = rPx * rPx;
  const h = (cell - 1) / 2, last = 512 / cell - 1;
  const c0 = (p: number) => Math.max(0, Math.ceil((p - rPx - h) / cell));
  const c1 = (p: number) => Math.min(last, Math.floor((p + rPx - h) / cell));
  for (let qy = c0(cy); qy <= c1(cy); qy++)
    for (let qx = c0(cx); qx <= c1(cx); qx++) {
      const x = qx * cell + h, y = qy * cell + h;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) m = Math.max(m, sampleInterpolated(a, b, f, alpha, x, y, cell));
    }
  return m;
}
