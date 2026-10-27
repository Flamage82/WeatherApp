import type { LevelField } from "../../shared/decodeFrame";

/** (dx,dy) pairs in full-res px (A -> B) on a gw x gh grid spanning the frame. */
export type FlowField = { gw: number; gh: number; data: Float32Array };

export const ZERO_FLOW: FlowField = { gw: 1, gh: 1, data: new Float32Array(2) };

const FULL = 512;
const DS = 4; // downsample factor
const SMALL = FULL / DS; // 128
const BLOCK = 8;
const STRIDE = 4;
const SEARCH = 8; // +-8 px on the 128 image = +-32 full-res px
const MIN_ACTIVE = 6;
const GRID = (SMALL - BLOCK) / STRIDE + 1; // 31
const FILL_RADIUS = 3;

function downsample(f: LevelField): Float32Array {
  const out = new Float32Array(SMALL * SMALL);
  const d = f.data;
  for (let y = 0; y < SMALL; y++)
    for (let x = 0; x < SMALL; x++) {
      let s = 0;
      for (let v = 0; v < DS; v++) {
        const row = (y * DS + v) * FULL + x * DS;
        for (let u = 0; u < DS; u++) s += d[row + u]!;
      }
      out[y * SMALL + x] = s / (DS * DS);
    }
  return out;
}

function median9(v: number[]): number {
  v.sort((p, q) => p - q);
  return v[4]!;
}

/** Coarse block-matching flow between two frames. Result vectors are full-res px, A -> B. */
export function computeFlow(a: LevelField, b: LevelField): FlowField {
  const A = downsample(a);
  const B = downsample(b);
  const n = GRID * GRID;
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  const valid = new Uint8Array(n);
  let anyValid = false;

  for (let j = 0; j < GRID; j++)
    for (let i = 0; i < GRID; i++) {
      const ox = i * STRIDE, oy = j * STRIDE;
      let active = 0;
      for (let y = 0; y < BLOCK; y++)
        for (let x = 0; x < BLOCK; x++) if (A[(oy + y) * SMALL + ox + x]! > 0) active++;
      if (active < MIN_ACTIVE) continue;

      let best = Infinity, bu = 0, bv = 0;
      for (let v = -SEARCH; v <= SEARCH; v++)
        for (let u = -SEARCH; u <= SEARCH; u++) {
          // Tiny bias toward small motion breaks ties (e.g. uniform interiors).
          let sad = 1e-4 * (u * u + v * v);
          for (let y = 0; y < BLOCK && sad < best; y++) {
            const by = oy + y + v;
            for (let x = 0; x < BLOCK; x++) {
              const bx = ox + x + u;
              const bval = bx < 0 || by < 0 || bx >= SMALL || by >= SMALL ? 0 : B[by * SMALL + bx]!;
              sad += Math.abs(A[(oy + y) * SMALL + ox + x]! - bval);
            }
          }
          if (sad < best) { best = sad; bu = u; bv = v; }
        }
      const k = j * GRID + i;
      vx[k] = bu; vy[k] = bv; valid[k] = 1; anyValid = true;
    }

  const out = new Float32Array(n * 2);
  if (!anyValid) return { gw: GRID, gh: GRID, data: out };

  // Fill invalid cells: 1/d^2 weighted mean of valid vectors within FILL_RADIUS cells.
  const fx = new Float32Array(vx), fy = new Float32Array(vy);
  for (let j = 0; j < GRID; j++)
    for (let i = 0; i < GRID; i++) {
      if (valid[j * GRID + i]) continue;
      let sw = 0, sx = 0, sy = 0;
      for (let dj = -FILL_RADIUS; dj <= FILL_RADIUS; dj++)
        for (let di = -FILL_RADIUS; di <= FILL_RADIUS; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= GRID || jj >= GRID) continue;
          const k = jj * GRID + ii;
          if (!valid[k]) continue;
          const w = 1 / (di * di + dj * dj);
          sw += w; sx += w * vx[k]!; sy += w * vy[k]!;
        }
      if (sw > 0) { fx[j * GRID + i] = sx / sw; fy[j * GRID + i] = sy / sw; }
    }

  // 3x3 median (edge-clamped) then one 3x3 box blur, then scale to full-res px.
  const filt = (src: Float32Array, op: (w: number[]) => number): Float32Array => {
    const dst = new Float32Array(n);
    const w: number[] = new Array(9);
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        let c = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const ii = Math.min(GRID - 1, Math.max(0, i + di));
            const jj = Math.min(GRID - 1, Math.max(0, j + dj));
            w[c++] = src[jj * GRID + ii]!;
          }
        dst[j * GRID + i] = op(w);
      }
    return dst;
  };
  const mean9 = (w: number[]) => w.reduce((s, q) => s + q, 0) / 9;
  const gx = filt(filt(fx, median9), mean9);
  const gy = filt(filt(fy, median9), mean9);
  for (let k = 0; k < n; k++) {
    out[2 * k] = gx[k]! * DS;
    out[2 * k + 1] = gy[k]! * DS;
  }
  return { gw: GRID, gh: GRID, data: out };
}

/**
 * Bilinear flow lookup at full-res pixel (x, y).
 * Grid mapping (the GPU shader must match): cell (i, j) of a gw x gh grid is centred at
 *   cx(i) = (i + 1) * 512 / (gw + 1),  cy(j) = (j + 1) * 512 / (gh + 1)
 * which for the 31x31 grid is 16*i + 16 (= block origin 4i + half block 4, times 4).
 * Grid coords gx = x * (gw + 1) / 512 - 1 are clamped to [0, gw-1] (nearest edge value outside).
 */
export function flowAt(f: FlowField, x: number, y: number): [number, number] {
  const gxr = Math.min(f.gw - 1, Math.max(0, (x * (f.gw + 1)) / FULL - 1));
  const gyr = Math.min(f.gh - 1, Math.max(0, (y * (f.gh + 1)) / FULL - 1));
  const x0 = Math.floor(gxr), y0 = Math.floor(gyr);
  const x1 = Math.min(f.gw - 1, x0 + 1), y1 = Math.min(f.gh - 1, y0 + 1);
  const tx = gxr - x0, ty = gyr - y0;
  const d = f.data;
  const at = (xx: number, yy: number, c: number) => d[(yy * f.gw + xx) * 2 + c]!;
  const lerp = (c: number) =>
    (at(x0, y0, c) * (1 - tx) + at(x1, y0, c) * tx) * (1 - ty) +
    (at(x0, y1, c) * (1 - tx) + at(x1, y1, c) * tx) * ty;
  return [lerp(0), lerp(1)];
}
