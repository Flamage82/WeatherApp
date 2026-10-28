import { describe, expect, it } from "vitest";
import { rainHint } from "./rainHint";

const STEP = 30_000;
/** Levels every 30 s for 60 min, `level` from `fromMin` on. */
const series = (fromMin: number, level: number) =>
  Float32Array.from({ length: 121 }, (_, k) => (k * STEP >= fromMin * 60_000 ? level : 0));

describe("rainHint", () => {
  it("says when rain arrives and how heavy", () => {
    expect(rainHint(series(24, 9), STEP)).toBe("Rain in ~25 min · heavy");
  });
  it("says nothing when no rain is forecast", () => {
    expect(rainHint(series(0, 0), STEP)).toBeNull();
  });
});
