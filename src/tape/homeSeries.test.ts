import { describe, expect, it } from "vitest";
import { CELL_SIZE, type ProductId } from "../../shared/config";
import type { LevelField } from "../../shared/decodeFrame";
import { IDENTITY_AFFINE } from "../../shared/gnomonic";
import { pointPixel } from "../../shared/homeSample";
import { parseMapFile } from "../../worker/mapFile";
import m504 from "../../shared/__fixtures__/IDR504.map?raw";
import type { FramePair } from "../data/frameStore";
import { ZERO_FLOW } from "../motion/flow";
import m503 from "../../worker/__fixtures__/IDR503.map?raw";
import { buildHomeForecast, buildHomeSeries } from "./homeSeries";

const CALVERT = { lat: -27.67217111736596, lon: 152.49661614726207 };

const g504 = parseMapFile(m504);
const T0 = Date.UTC(2026, 9, 27, 6, 0);
const T1 = T0 + 300_000;

function field(level: number, r = 0): LevelField {
  const { x, y } = pointPixel(g504, CALVERT);
  const data = new Uint8Array(512 * 512);
  for (let py = 0; py < 512; py++)
    for (let px = 0; px < 512; px++) if ((px - x) ** 2 + (py - y) ** 2 <= r * r) data[py * 512 + px] = level;
  return { width: 512, height: 512, data };
}

/** A store with one pair, A = a level-10 disc on home, B empty, zero flow. */
const A = field(10, 12), B = field(0);
const store = {
  frames: () => [T0, T1],
  getPair: (_p: unknown, t: number): FramePair => {
    const alpha = Math.min(1, Math.max(0, (t - T0) / (T1 - T0)));
    return {
      a: A, b: B, flow: ZERO_FLOW, alpha, cell: CELL_SIZE.IDR504,
      fromMs: T0, toMs: T1, motion: IDENTITY_AFFINE, motionFrom: "IDR504",
    };
  },
};

describe("buildHomeForecast", () => {
  const g503 = parseMapFile(m503);
  const empty = field(0);
  const six: LevelField = { width: 512, height: 512, data: new Uint8Array(512 * 512).fill(6) };
  const tapeFlow = { gw: 1, gh: 1, data: new Float32Array([0.001, 0]) }; // 3600 px in an hour: far off the frame
  const nested = {
    frames: () => [T0, T1],
    geometry: (p: ProductId) => (p === "IDR504" ? g504 : p === "IDR503" ? g503 : null),
    getPair: (p: ProductId, t: number): FramePair => {
      const a = p === "IDR504" ? empty : six;
      const base = { a, b: a, cell: CELL_SIZE[p], motion: IDENTITY_AFFINE, motionFrom: p };
      return t > T1
        ? { ...base, flow: p === "IDR504" ? tapeFlow : ZERO_FLOW, alpha: 0, forecastLeadMs: t - T1, fromMs: T1, toMs: T1 }
        : { ...base, flow: ZERO_FLOW, alpha: 1, fromMs: T0, toMs: T1 };
    },
  };

  it("takes rain from the coarser range once the tape range's source point leaves its frame", () => {
    const h = buildHomeForecast(nested, ["IDR504", "IDR503"], CALVERT)!;
    expect(h.fromMs).toBe(T1);
    expect(h.values[0]).toBe(0); // at the newest frame the tape range's own (empty) image shows
    expect(h.values[120]).toBe(6); // an hour on, the 503 image fills in
  });
});

describe("buildHomeForecast with a stalled range", () => {
  it("ignores a coarser range whose newest frame is more than a frame interval behind the tape product's", () => {
    const g503 = parseMapFile(m503);
    const six: LevelField = { width: 512, height: 512, data: new Uint8Array(512 * 512).fill(6) };
    const empty = field(0);
    const flow = { gw: 1, gh: 1, data: new Float32Array([0.001, 0]) };
    const store = {
      frames: (p: ProductId) => (p === "IDR504" ? [T0, T1] : [T0 - 3_600_000, T1 - 600_000]),
      geometry: (p: ProductId) => (p === "IDR504" ? g504 : p === "IDR503" ? g503 : null),
      getPair: (p: ProductId, t: number): FramePair => {
        const a = p === "IDR504" ? empty : six;
        const base = { a, b: a, cell: CELL_SIZE[p], motion: IDENTITY_AFFINE, motionFrom: p, alpha: 0 };
        return t > T1
          ? { ...base, flow: p === "IDR504" ? flow : ZERO_FLOW, forecastLeadMs: t - T1, fromMs: T1, toMs: T1 }
          : { ...base, flow: ZERO_FLOW, fromMs: T0, toMs: T1 };
      },
    };
    const h = buildHomeForecast(store, ["IDR504", "IDR503"], CALVERT)!;
    expect(h.values[120]).toBe(0); // the stalled 503 image is not painted in
  });
});

describe("buildHomeSeries", () => {
  it("interpolates the home disc every 30 s across the pair", () => {
    const s = buildHomeSeries(store, "IDR504", g504, CALVERT, T0, T1);
    expect(s.length).toBe((T1 - T0) / 30_000 + 1);
    expect(s[0]).toBe(10);
    expect(s[5]).toBe(5);
    expect(s[10]).toBe(0);
  });

  it("is NaN outside the frame range", () => {
    const s = buildHomeSeries(store, "IDR504", g504, CALVERT, T0 - 60_000, T1 + 60_000);
    expect(s[0]).toBeNaN();
    expect(s[1]).toBeNaN();
    expect(s[2]).toBe(10);
    expect(s[s.length - 1]).toBeNaN();
  });
});
