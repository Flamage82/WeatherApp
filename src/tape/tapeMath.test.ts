import { describe, expect, it } from "vitest";
import { DEFAULT_SPAN_MS, flingStep, pxToMs, seriesToColumns, tickStepMs, zoomSpan } from "./tapeMath";

describe("tape math", () => {
  it("pxToMs scales the drag with the span", () => {
    expect(pxToMs(100, 400, DEFAULT_SPAN_MS)).toBe(600_000);
    expect(pxToMs(100, 400, 86_400_000)).toBe(21_600_000);
  });

  it("zoomSpan divides by the scale, clamped to 20 min .. 7 days", () => {
    expect(zoomSpan(2_400_000, 2)).toBe(1_200_000);
    expect(zoomSpan(1_200_000, 2)).toBe(1_200_000);
    expect(zoomSpan(604_800_000, 0.5)).toBe(604_800_000);
  });

  it("tickStepMs gives at most 6 labels (1 day at most)", () => {
    expect(tickStepMs(2_400_000)).toBe(600_000);
    expect(tickStepMs(86_400_000)).toBe(21_600_000);
    expect(tickStepMs(604_800_000)).toBe(86_400_000);
  });

  it("seriesToColumns takes each column's max, filling short gaps from the nearest point", () => {
    const pts: [string, number][] = [["202610270000", 3], ["202610270005", 9], ["202610270010", 2]];
    const from = Date.UTC(2026, 9, 27, 0, 0), to = Date.UTC(2026, 9, 27, 0, 10);
    expect(Array.from(seriesToColumns(pts, from, to, 2))).toEqual([3, 9]);
    const ends: [string, number][] = [["202610270000", 3], ["202610270010", 2]];
    expect(Array.from(seriesToColumns(ends, from, to, 20)).some(Number.isNaN)).toBe(false);
    const far = seriesToColumns(ends, to + 3 * 3_600_000, to + 3 * 3_600_000 + 60_000, 1);
    expect(far[0]).toBeNaN();
  });

  it("flingStep halves every 250 ms and stops below the threshold", () => {
    expect(flingStep(1, 250)).toBeCloseTo(0.5, 9);
    expect(flingStep(0.04, 16)).toBe(0);
  });
});
