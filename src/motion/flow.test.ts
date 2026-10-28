import { describe, it, expect } from "vitest";
import type { LevelField } from "../../shared/decodeFrame";
import { computeFlow, flowAt, forecastFlow, ZERO_FLOW, type FlowField } from "./flow";

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
  it("identical frames give ~zero flow", () => {
    const f = computeFlow(makeDisc(200, 200, 20, 10), makeDisc(200, 200, 20, 10));
    for (let i = 0; i < f.data.length; i += 2) expect(Math.hypot(f.data[i]!, f.data[i + 1]!)).toBeLessThan(0.5);
  });
  it("empty frames give all zero", () => {
    const f = computeFlow(empty(), empty());
    expect(f.gw).toBe(31);
    expect(f.data.every((v) => v === 0)).toBe(true);
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

describe("forecastFlow", () => {
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
