import { describe, expect, it } from "vitest";
import { leverToSpeed, speedToLever } from "./leverMath";

describe("lever math", () => {
  it("leverToSpeed runs −4..4 from the ends through 0 in the middle", () => {
    expect(leverToSpeed(0.5)).toBe(0);
    expect(leverToSpeed(1)).toBe(4);
    expect(leverToSpeed(0)).toBe(-4);
  });

  it("is logarithmic: the slow speeds take up room around the middle", () => {
    // A tenth of the lever's length above the middle is a slow scrub; a linear lever would give 0.8×.
    const slow = leverToSpeed(0.6);
    expect(slow).toBeGreaterThan(0.1);
    expect(slow).toBeLessThan(0.25);
    expect(leverToSpeed(0.4)).toBeCloseTo(-slow, 12);
    // Half of the upper half is still under 1×.
    expect(leverToSpeed(0.75)).toBeLessThan(1);
    // Speed rises steadily with lever position.
    let last = -Infinity;
    for (let p = 0; p <= 1; p += 0.01) {
      const s = leverToSpeed(p);
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
  });

  it("snaps to a detent near its lever position", () => {
    for (const d of [-4, -2, -1, 0, 1, 2, 4]) {
      expect(leverToSpeed(speedToLever(d) + 0.01)).toBe(d);
      expect(leverToSpeed(speedToLever(d) - 0.01)).toBe(d);
    }
  });

  it("speedToLever inverts it between the detents", () => {
    for (const s of [-3, -1.5, -0.5, -0.2, 0.2, 0.5, 1.5, 3]) expect(leverToSpeed(speedToLever(s))).toBeCloseTo(s, 9);
  });
});
