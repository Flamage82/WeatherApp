import { describe, expect, it } from "vitest";
import { leverToSpeed, speedToLever } from "./leverMath";

describe("lever math", () => {
  it("leverToSpeed is linear −4..4 with detents", () => {
    expect(leverToSpeed(0.5)).toBe(0);
    expect(leverToSpeed(1)).toBe(4);
    expect(leverToSpeed(0)).toBe(-4);
    expect(leverToSpeed(0.5 + 1.08 / 8)).toBe(1); // within detent of 1×
  });

  it("speedToLever inverts it", () => {
    expect(speedToLever(2)).toBeCloseTo(0.75);
  });
});
