import { describe, it, expect } from "vitest";
import type { LevelField } from "../../shared/decodeFrame";
import { computeFlow, flowAt, flowAtBoth, forecastFlow, ZERO_FLOW, type FlowField } from "./flow";

export function makeDisc(cx: number, cy: number, r: number, level: number, into?: LevelField): LevelField {
  const f: LevelField = into ?? { width: 512, height: 512, data: new Uint8Array(512 * 512) };
  for (let y = Math.max(0, cy - r); y <= Math.min(511, cy + r); y++)
    for (let x = Math.max(0, cx - r); x <= Math.min(511, cx + r); x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) f.data[y * 512 + x] = level;
  return f;
}
const empty = (): LevelField => ({ width: 512, height: 512, data: new Uint8Array(512 * 512) });

describe("computeFlow", () => {
  it("recovers disc motion (16, 8)", () => {
    const f = computeFlow(makeDisc(200, 200, 20, 10), makeDisc(216, 208, 20, 10));
    const [dx, dy] = flowAt(f, 208, 204);
    console.log("recovered flow", dx, dy);
    expect(Math.abs(dx - 16)).toBeLessThan(1.5);
    expect(Math.abs(dy - 8)).toBeLessThan(1.5);
  });
  it("recovers a shift that isn't a multiple of 4 px to within 1 px (sub-pixel)", () => {
    for (const [dx, dy] of [[18, 6], [6, 18]] as const) {
      const [vx, vy] = flowAt(computeFlow(patch(0, 0), patch(dx, dy)), 225, 225);
      expect(Math.abs(vx - dx)).toBeLessThan(1);
      expect(Math.abs(vy - dy)).toBeLessThan(1);
    }
  });
  it("identical frames give ~zero flow", () => {
    const f = computeFlow(makeDisc(200, 200, 20, 10), makeDisc(200, 200, 20, 10));
    for (let i = 0; i < f.data.length; i += 2) expect(Math.hypot(f.data[i]!, f.data[i + 1]!)).toBeLessThan(0.5);
  });
  it("empty frames give all zero", () => {
    const f = computeFlow(empty(), empty());
    expect(f.gw).toBe(31);
    expect(f.data.every((v) => v === 0)).toBe(true);
  });
  it("flowAtBoth gives exactly flowAt of the detailed and of the large-scale field", () => {
    const v = forecastFlow([cellFlow((cx, cy) => [1e-5 * Math.sin(cx / 50), 1e-5 * Math.cos(cy / 70)])], [1]);
    for (const [x, y] of [[100.3, 200.7], [256, 256], [-20, 600], [511.9, 3.1]] as const)
      expect(flowAtBoth(v, x, y)).toEqual([...flowAt(v, x, y), ...flowAt(v, x, y, v.large)]);
  });
  it("flowAt clamps and ZERO_FLOW is zero", () => {
    expect(flowAt(ZERO_FLOW, 100, 100)).toEqual([0, 0]);
    expect(flowAt(ZERO_FLOW, -5, 900)).toEqual([0, 0]);
  });
  it("runs fast on 512x512", () => {
    const a = makeDisc(200, 200, 20, 10);
    makeDisc(380, 120, 30, 6, a);
    const b = makeDisc(216, 208, 20, 10);
    makeDisc(390, 125, 30, 6, b);
    const t0 = performance.now();
    computeFlow(a, b);
    const ms = performance.now() - t0;
    console.log(`computeFlow took ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(500);
  });
});

/** A textured square of rain (pseudo-random 8 px tiles), shifted by (dx, dy). */
const patch = (dx: number, dy: number): LevelField => {
  const f = empty();
  for (let y = 150; y < 300; y++)
    for (let x = 150; x < 300; x++) {
      const tx = (x - 150) >> 3, ty = (y - 150) >> 3;
      f.data[(y + dy) * 512 + x + dx] = 1 + (((tx * 73856093) ^ (ty * 19349663)) >>> 0) % 15;
    }
  return f;
};

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

describe("forecastFlow", () => {
  it("gives a large-scale field equal to a uniform motion", () => {
    const v = forecastFlow([cellFlow(() => [30, -12])], [300_000]);
    expect(v.large).toBeDefined();
    expect(flowAt(v, 256, 256, v.large)[0]).toBeCloseTo(30 / 300_000, 10);
    expect(flowAt(v, 40, 470, v.large)[1]).toBeCloseTo(-12 / 300_000, 10);
  });

  it("smooths a short wave out of the large-scale field", () => {
    const a = 3e-6;
    const v = forecastFlow([cellFlow((cx) => [0, a * Math.sin((2 * Math.PI * cx) / 64)])], [1]);
    // cx = 272 is a wave crest (sin(8.5π) = 1): the detailed field keeps it, the large-scale one doesn't.
    expect(flowAt(v, 272, 256)[1]).toBeCloseTo(a, 9);
    expect(Math.abs(flowAt(v, 272, 256, v.large)[1])).toBeLessThan(0.1 * a);
  });

  it("gives zero data and zero large-scale motion when nothing was measured", () => {
    const dry: FlowField = { gw: 31, gh: 31, data: new Float32Array(31 * 31 * 2), valid: new Uint8Array(31 * 31) };
    const v = forecastFlow([dry], [300_000]);
    expect(v.data.every((x) => x === 0)).toBe(true);
    expect(v.large?.every((x) => x === 0)).toBe(true);
  });

  it("fills a far empty corner with the patch's motion, in px/ms", () => {
    const v = forecastFlow([computeFlow(patch(0, 0), patch(16, 8))], [300_000]);
    for (const [x, y] of [[500, 500], [10, 500], [500, 10]] as const) {
      const [vx, vy] = flowAt(v, x, y);
      expect(Math.abs(vx / (16 / 300_000) - 1)).toBeLessThan(0.1);
      expect(Math.abs(vy / (8 / 300_000) - 1)).toBeLessThan(0.1);
    }
  });

  it("averages pair flows divided by their gaps", () => {
    const uniform = (dx: number): FlowField => ({
      gw: 31, gh: 31, data: new Float32Array(31 * 31 * 2).map((_, k) => (k % 2 ? 0 : dx)), valid: new Uint8Array(31 * 31).fill(1),
    });
    const v = forecastFlow([uniform(10), uniform(40)], [300_000, 600_000]);
    expect(flowAt(v, 256, 256)[0]).toBeCloseTo((10 / 300_000 + 40 / 600_000) / 2, 10);
  });
});
