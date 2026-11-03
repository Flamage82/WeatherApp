import { describe, expect, it } from "vitest";
import { rainHint } from "./rainHint";

const STEP = 30_000;
/** Levels every 30 s for 3 h, `level` from `fromMin` on (until `toMin`, if given). */
const series = (fromMin: number, level: number, toMin = Infinity) =>
  Float32Array.from({ length: 361 }, (_, k) => (k * STEP >= fromMin * 60_000 && k * STEP < toMin * 60_000 ? level : 0));

describe("rainHint", () => {
  it("says when rain arrives and how heavy", () => {
    expect(rainHint(series(24, 9), STEP)).toBe("Rain in ~25 min · heavy");
  });
  it("reads a lead past an hour as hours and minutes", () => {
    expect(rainHint(series(130, 9), STEP)).toBe("Rain in ~2 h 10 min · heavy");
  });
  it("reads an end past an hour the same way", () => {
    expect(rainHint(series(0, 5, 90), STEP)).toBe("Raining now · moderate · until ~1 h 30 min");
  });
  it("says nothing when no rain is forecast", () => {
    expect(rainHint(series(0, 0), STEP)).toBeNull();
  });
});
