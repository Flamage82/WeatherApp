import { describe, it, expect } from "vitest";
import type { LevelField } from "../../shared/decodeFrame";
import { computeFlow, ZERO_FLOW, flowAt } from "./flow";
import { sampleForecast, sampleInterpolated, sampleInterpolatedMaxInDisc } from "./interpolate";

function makeDisc(cx: number, cy: number, r: number, level: number): LevelField {
  const f: LevelField = { width: 512, height: 512, data: new Uint8Array(512 * 512) };
  for (let y = 0; y < 512; y++)
    for (let x = 0; x < 512; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) f.data[y * 512 + x] = level;
  return f;
}
const empty = (): LevelField => ({ width: 512, height: 512, data: new Uint8Array(512 * 512) });

describe("sampleInterpolated", () => {
  const a = makeDisc(200, 200, 20, 10);
  const b = makeDisc(216, 208, 20, 10);
  const f = computeFlow(a, b);

  it("disc is halfway at alpha 0.5", () => {
    expect(sampleInterpolated(a, b, f, 0.5, 208, 204)).toBeGreaterThan(9);
    expect(sampleInterpolated(a, b, f, 0.5, 208, 204)).toBeLessThan(10.5);
  });
  it("moves rather than crossfades", () => {
    expect(sampleInterpolated(a, b, f, 0.5, 184, 204)).toBeLessThan(2);
  });
  it("never exceeds max(wa, wb)", () => {
    const samp = (fl: LevelField, x: number, y: number) => {
      const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
      const g = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx > 511 || yy > 511 ? 0 : fl.data[yy * 512 + xx]!);
      return (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty;
    };
    for (const al of [0.25, 0.5, 0.75])
      for (let i = 0; i < 64; i++)
        for (let j = 0; j < 64; j++) {
          const x = i * 8 + 3.3, y = j * 8 + 1.7;
          const [dx, dy] = flowAt(f, x, y);
          const wa = samp(a, x - al * dx, y - al * dy);
          const wb = samp(b, x + (1 - al) * dx, y + (1 - al) * dy);
          expect(sampleInterpolated(a, b, f, al, x, y)).toBeLessThanOrEqual(Math.max(wa, wb) + 1e-9);
        }
  });
  it("new cell crossfades", () => {
    const e = empty();
    const nb = makeDisc(300, 300, 15, 10);
    const v = sampleInterpolated(e, nb, computeFlow(e, nb), 0.5, 300, 300);
    expect(v).toBeGreaterThan(4.5);
    expect(v).toBeLessThan(5.5);
  });
  it("max in disc", () => {
    const m = sampleInterpolatedMaxInDisc(a, a, ZERO_FLOW, 0.5, 215, 200, 10);
    expect(m).toBe(10);
    expect(sampleInterpolatedMaxInDisc(a, a, ZERO_FLOW, 0.5, 400, 400, 10)).toBe(0);
  });
});

describe("sampleForecast", () => {
  it("advects the newest frame along the forecast flow", () => {
    const a = makeDisc(200, 200, 5, 10);
    const v = { gw: 1, gh: 1, data: new Float32Array([1 / 60_000, 0]) }; // 1 px/min to the right
    expect(sampleForecast(a, v, 10 * 60_000, 210, 200)).toBe(10);
    expect(sampleForecast(a, v, 0, 210, 200)).toBe(0);
  });
});

describe("native cell size", () => {
  /** The pre-cell (Task 8) per-pixel bilinear, kept verbatim as the k = 1 reference. */
  const oldBilinear = (fl: LevelField, x: number, y: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    const g = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= 512 || yy >= 512 ? 0 : fl.data[yy * 512 + xx]!);
    return (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty;
  };
  /** 2x2-replicated field (phase 0): cell (cx, cy) -> level(cx, cy). */
  const cells2 = (level: (cx: number, cy: number) => number): LevelField => {
    const f = empty();
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) f.data[y * 512 + x] = level(x >> 1, y >> 1);
    return f;
  };

  it("k = 1 is exactly the old per-pixel bilinear (and the default)", () => {
    const a = makeDisc(200, 200, 20, 10), b = makeDisc(216, 208, 20, 10), f = computeFlow(a, b);
    for (const al of [0, 0.3, 1])
      for (let i = 0; i < 40; i++) {
        const x = i * 13.37 - 7.1, y = i * 11.9 + 0.4;
        const [dx, dy] = flowAt(f, x, y);
        const wa = oldBilinear(a, x - al * dx, y - al * dy);
        const wb = oldBilinear(b, x + (1 - al) * dx, y + (1 - al) * dy);
        const ref = Math.min((1 - al) * wa + al * wb, Math.max(wa, wb));
        expect(sampleInterpolated(a, b, f, al, x, y, 1)).toBe(ref);
        expect(sampleInterpolated(a, b, f, al, x, y)).toBe(ref);
      }
  });

  it("k = 2 interpolates between cell centres: no plateau-plus-ramp staircase", () => {
    // Cells step 0, 2, 4, 6, ... along x; centres at pixel 2c + 0.5.
    const f = cells2((cx) => Math.min(15, 2 * cx));
    const s = (x: number) => sampleInterpolated(f, f, ZERO_FLOW, 0, x, 100, 2);
    expect(s(2 * 3 + 0.5)).toBeCloseTo(6, 12); // a cell centre returns the cell value
    expect(s(2 * 3 + 1.5)).toBeCloseTo(7, 12); // halfway between centres
    // Constant slope of 1 level/px across pixel positions: every step is equal, none flat.
    for (let x = 1; x < 12; x++) expect(s(x + 1) - s(x)).toBeCloseTo(1, 12);
    // k = 1 on the same data has flat steps inside each cell.
    const s1 = (x: number) => sampleInterpolated(f, f, ZERO_FLOW, 0, x, 100, 1);
    expect(s1(3) - s1(2)).toBe(0);
  });

  it("k = 2 reads 0 outside the frame and never overshoots its cells", () => {
    const f = cells2(() => 8);
    const s = (x: number, y: number) => sampleInterpolated(f, f, ZERO_FLOW, 0, x, y, 2);
    expect(s(-1.5, 200)).toBe(0); // centre of cell -1
    expect(s(-0.5, 200)).toBeCloseTo(4, 12); // halfway to cell 0's centre
    expect(s(0.5, 200)).toBe(8);
    expect(s(511.5 + 1, 200)).toBe(0); // centre of cell 256
    const g = cells2((cx, cy) => (cx * 7 + cy * 3) % 16);
    for (let i = 0; i < 500; i++) {
      const x = (i * 37.13) % 512, y = (i * 19.71) % 512;
      const cx = Math.floor((x - 0.5) / 2), cy = Math.floor((y - 0.5) / 2);
      let hi = 0;
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const X = cx + u, Y = cy + v;
        if (X >= 0 && Y >= 0 && X < 256 && Y < 256) hi = Math.max(hi, (X * 7 + Y * 3) % 16);
      }
      expect(sampleInterpolated(g, g, ZERO_FLOW, 0, x, y, 2)).toBeLessThanOrEqual(hi + 1e-12);
    }
  });

  it("max in disc samples at cell centres (as maxLevelInDisc does)", () => {
    const f = cells2((cx) => (cx === 100 ? 12 : 0));
    // Pixel 200.5 is cell 100's centre, 0.5 px from x = 200: inside a 0.6 px disc, read in full.
    expect(sampleInterpolatedMaxInDisc(f, f, ZERO_FLOW, 0, 200, 50.5, 0.6, 2)).toBe(12);
    // A 0.4 px disc holds no cell centre at all.
    expect(sampleInterpolatedMaxInDisc(f, f, ZERO_FLOW, 0, 200, 50.5, 0.4, 2)).toBe(0);
  });
});
