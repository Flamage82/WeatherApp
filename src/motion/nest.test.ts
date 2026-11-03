import { describe, expect, it } from "vitest";
import type { LevelField } from "../../shared/decodeFrame";
import { IDENTITY_AFFINE } from "../../shared/gnomonic";
import { ZERO_FLOW, type FlowField } from "./flow";
import { sampleForecast } from "./interpolate";
import { edgeDist, edgeWeight, isFresh, nestSlotSample, sampleNested, type NestSlot } from "./nest";

const field = (level: (x: number, y: number) => number): LevelField => {
  const f: LevelField = { width: 512, height: 512, data: new Uint8Array(512 * 512) };
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) f.data[y * 512 + x] = level(x >> 1, y >> 1);
  return f;
};
const uniform = (level: number) => field(() => level);
const uniformFlow = (vx: number, vy: number): FlowField => ({ gw: 1, gh: 1, data: new Float32Array([vx, vy]) });

const slot = (over: Partial<NestSlot>): NestSlot => ({
  a: uniform(0), b: uniform(0), flow: ZERO_FLOW, alpha: 0, leadMs: 0, cell: 2, band: 0,
  motion: IDENTITY_AFFINE, fresh: true, ...over,
});

describe("edgeDist", () => {
  it("is measured from the data area inside the frame's 16 px no-data border", () => {
    // BOM's frames carry nothing in their outer 16 px (measured: the share of non-zero pixels steps up at
    // exactly 16 px in IDR502, 503 and 504), so a finer range must not claim weight over it.
    expect(edgeDist(15.5, 256)).toBe(0);
    expect(edgeDist(14.5, 256)).toBe(-1);
    expect(edgeDist(495.5, 256)).toBe(0);
    expect(edgeDist(255.5, 255.5)).toBe(240);
  });
});

describe("edgeWeight", () => {
  it("is 0 outside, a smoothstep across the band, a hard edge for band 0", () => {
    expect(edgeWeight(-1, 20)).toBe(0);
    expect(edgeWeight(0, 0)).toBe(1);
    expect(edgeWeight(0, 20)).toBe(0);
    expect(edgeWeight(10, 20)).toBe(0.5);
    expect(edgeWeight(25, 20)).toBe(1);
  });
});

describe("nestSlotSample", () => {
  it("nowcast with identity motion matches sampleForecast", () => {
    const a = field((cx, cy) => (cx * 7 + cy * 13) % 16);
    const v = uniformFlow(0.0004, -0.0002);
    const lead = 300_000;
    const s = slot({ a, flow: v, leadMs: lead });
    for (let y = 150; y < 400; y += 37.3)
      for (let x = 150; x < 400; x += 41.1) {
        const r = nestSlotSample(s, x, y);
        expect(r.level).toBe(sampleForecast(a, v, lead, x, y, 2));
        expect(r.weight).toBe(1);
      }
  });

  it("has weight 0 where the nowcast source point is outside the frame", () => {
    const s = slot({ a: uniform(9), flow: uniformFlow(0.01, 0), leadMs: 60_000 });
    expect(nestSlotSample(s, 100, 256).weight).toBe(0);
  });

  it("reads through the motion affine: 0.5 scale doubles the fine-px displacement", () => {
    const a = field((cx, cy) => (cx === 90 && cy === 50 ? 10 : 0)); // cell centre at pixel (180.5, 100.5)
    const s = slot({
      a, flow: uniformFlow(0.001, 0), leadMs: 10_000, motion: { sx: 0.5, ox: 128, sy: 0.5, oy: 128 },
    });
    const hit = nestSlotSample(s, 200.5, 100.5); // flow is Float32, so 0.001 px/ms is not exact
    expect(hit.level).toBeCloseTo(10, 3);
    expect(hit.weight).toBe(1);
    expect(nestSlotSample(s, 180.5, 100.5).level).toBe(0);
  });

  it("integrates through the motion affine across several steps", () => {
    const a = field((cx, cy) => (cx === 90 && cy === 50 ? 10 : 0)); // cell centre at pixel (180.5, 100.5)
    const s = slot({ a, flow: uniformFlow(1 / 60_000, 0), leadMs: 1_200_000, motion: { sx: 0.5, ox: 128, sy: 0.5, oy: 128 } });
    // 20 min × 1/60_000 motion px/ms = 20 motion px = 40 slot px
    expect(nestSlotSample(s, 220.5, 100.5).level).toBeCloseTo(10, 3);
    expect(nestSlotSample(s, 180.5, 100.5).level).toBe(0);
  });
});

describe("sampleNested", () => {
  const fine = (over: Partial<NestSlot> = {}) => slot({ a: uniform(8), b: uniform(8), band: 20, ...over });
  const coarse = (over: Partial<NestSlot> = {}) => slot({ a: uniform(2), b: uniform(2), ...over });
  const mid = { x: 256, y: 256 };

  it("shows the finest level in the interior and blends 50/50 halfway through the band", () => {
    expect(sampleNested([fine(), coarse()], [mid, mid])).toBe(8);
    const edge = sampleNested([fine(), coarse()], [{ x: 25.5, y: 256 }, mid])!; // edgeDist 10
    expect(edge).toBeCloseTo(0.5 * 8 + 0.5 * 2, 12);
  });

  it("skips a stale slot while a fresh one has data, but falls back to the finest stale one", () => {
    expect(sampleNested([fine({ fresh: false }), coarse()], [mid, mid])).toBe(2);
    expect(sampleNested([fine({ fresh: false }), coarse({ fresh: false })], [mid, mid])).toBe(8);
  });

  it("is null where nothing covers the point", () => {
    const out = { x: -5, y: 256 };
    expect(sampleNested([fine(), coarse()], [out, out])).toBeNull();
  });
});

describe("isFresh", () => {
  it("allows one frame interval of tolerance either side of the pair", () => {
    expect(isFresh({ fromMs: 0, toMs: 300_000 }, 600_000)).toBe(true);
    expect(isFresh({ fromMs: 0, toMs: 300_000 }, 600_001)).toBe(false);
    expect(isFresh({ fromMs: 0, toMs: 300_000 }, -300_000)).toBe(true);
    expect(isFresh({ fromMs: 0, toMs: 300_000 }, -300_001)).toBe(false);
  });
});
