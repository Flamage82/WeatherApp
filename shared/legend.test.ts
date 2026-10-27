import { describe, expect, it } from "vitest";
import { BOM_LEGEND, rgbToLevel } from "./legend";

describe("legend", () => {
  it("maps legend colours to levels", () => {
    expect(rgbToLevel(0xf5, 0xf5, 0xff)).toBe(1);
    expect(rgbToLevel(0x28, 0x00, 0x00)).toBe(15);
  });
  it("treats banner colours as no rain", () => {
    expect(rgbToLevel(0, 0, 0)).toBe(0);
    expect(rgbToLevel(0xc0, 0xc0, 0xc0)).toBe(0);
    expect(rgbToLevel(0xff, 0xff, 0xff)).toBe(0);
  });
  it("has 15 ascending levels and rates", () => {
    expect(BOM_LEGEND.map((e) => e.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const rates = BOM_LEGEND.map((e) => e.mmh);
    expect([...rates].sort((a, b) => a - b)).toEqual(rates);
  });
  it("round-trips every entry", () => {
    for (const e of BOM_LEGEND) {
      expect(rgbToLevel((e.rgb >> 16) & 255, (e.rgb >> 8) & 255, e.rgb & 255)).toBe(e.level);
    }
  });
});
