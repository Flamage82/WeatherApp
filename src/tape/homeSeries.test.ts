import { describe, expect, it } from "vitest";
import { CELL_SIZE } from "../../shared/config";
import type { LevelField } from "../../shared/decodeFrame";
import { homePixel } from "../../shared/homeSample";
import { parseMapFile } from "../../worker/mapFile";
import m504 from "../../shared/__fixtures__/IDR504.map?raw";
import type { FramePair } from "../data/frameStore";
import { ZERO_FLOW } from "../motion/flow";
import { buildHomeSeries } from "./homeSeries";

const g504 = parseMapFile(m504);
const T0 = Date.UTC(2026, 9, 27, 6, 0);
const T1 = T0 + 300_000;

function field(level: number, r = 0): LevelField {
  const { x, y } = homePixel(g504);
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
    return { a: A, b: B, flow: ZERO_FLOW, alpha, cell: CELL_SIZE.IDR504 };
  },
};

describe("buildHomeSeries", () => {
  it("interpolates the home disc every 30 s across the pair", () => {
    const s = buildHomeSeries(store, "IDR504", g504, T0, T1);
    expect(s.length).toBe((T1 - T0) / 30_000 + 1);
    expect(s[0]).toBe(10);
    expect(s[5]).toBe(5);
    expect(s[10]).toBe(0);
  });

  it("is NaN outside the frame range", () => {
    const s = buildHomeSeries(store, "IDR504", g504, T0 - 60_000, T1 + 60_000);
    expect(s[0]).toBeNaN();
    expect(s[1]).toBeNaN();
    expect(s[2]).toBe(10);
    expect(s[s.length - 1]).toBeNaN();
  });
});
