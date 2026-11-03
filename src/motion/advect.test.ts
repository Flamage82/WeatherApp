import { describe, expect, it } from "vitest";
import { NOWCAST_MAX_MS } from "../../shared/config";
import { advectBack, NOWCAST_STEP_MS, nowcastDeformation } from "./advect";
import { flowAt, forecastFlow, type FlowField } from "./flow";

/** A 31x31 field, every cell measured, with `fn(cx, cy)` at each cell centre (full-res px). */
const cellFlow = (fn: (cx: number, cy: number) => [number, number]): FlowField => {
  const data = new Float32Array(31 * 31 * 2);
  for (let j = 0; j < 31; j++)
    for (let i = 0; i < 31; i++) {
      const [x, y] = fn(16 * i + 16, 16 * j + 16);
      data[2 * (j * 31 + i)] = x;
      data[2 * (j * 31 + i) + 1] = y;
    }
  return { gw: 31, gh: 31, data, valid: new Uint8Array(31 * 31).fill(1) };
};

const H = [1_800_000, 3_600_000, 7_200_000, 10_800_000];
const mid = { from: 192, to: 320 };

describe("nowcast advection", () => {
  it("the old single jump folds a diverging field before +3 h; the stepped path never does", () => {
    const c = 1 / 7_200_000; // single-jump fold at +2 h
    const v = forecastFlow([cellFlow((cx) => [c * (cx - 256), 0])], [1]);
    expect(nowcastDeformation(v, 10_800_000, { singleJump: true, ...mid }).minDet).toBeLessThan(0);
    for (const lead of H) expect(nowcastDeformation(v, lead, mid).minDet).toBeGreaterThan(0);
  });

  it("easing stops a shear wave's stretching from growing after RELAX_MS", () => {
    const v = forecastFlow([cellFlow((cx) => [0, 3e-6 * Math.sin((2 * Math.PI * cx) / 64)])], [1]);
    const noEase = { ...v, large: v.data };
    const ratio = (f: FlowField) =>
      nowcastDeformation(f, 10_800_000, mid).maxStretch / nowcastDeformation(f, 3_600_000, mid).maxStretch;
    expect(ratio(v)).toBeLessThan(1.25);
    expect(ratio(noEase)).toBeGreaterThan(1.5);
  });

  it("stays within a fraction of a pixel of the old single jump at a lead within one step, with easing off", () => {
    const v = forecastFlow([cellFlow((cx, cy) => [1e-5 * Math.sin(cx / 50), 1e-5 * Math.cos(cy / 70)])], [1]);
    const off = { ...v, large: v.data };
    for (const [x, y] of [[100.3, 200.7], [256, 256], [410.5, 90.25]] as const) {
      const [vx, vy] = flowAt(off, x, y);
      const [sx, sy] = advectBack(off, x, y, 240_000);
      expect(Math.abs(sx - (x - 240_000 * vx))).toBeLessThan(0.25);
      expect(Math.abs(sy - (y - 240_000 * vy))).toBeLessThan(0.25);
    }
  });

  it("doesn't fold where a 5-minute Euler step would flip the mapping (step x gradient > 1)", () => {
    const c = 1.2 / NOWCAST_STEP_MS; // gradient: one Euler step multiplies the spacing by 1 - 1.2 = -0.2
    const v = forecastFlow([cellFlow((cx) => [c * (cx - 256), 0])], [1]);
    const off = { ...v, large: v.data };
    expect(nowcastDeformation(off, 3 * NOWCAST_STEP_MS, mid).minDet).toBeGreaterThan(0);
  });

  it("caps at MAX_NOWCAST_STEPS: a lead past NOWCAST_MAX_MS goes no further", () => {
    const v: FlowField = { gw: 1, gh: 1, data: new Float32Array([1e-5, 0]) };
    expect(advectBack(v, 256, 256, NOWCAST_MAX_MS + 600_000)).toEqual(advectBack(v, 256, 256, NOWCAST_MAX_MS));
  });
});
