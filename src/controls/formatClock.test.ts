import { describe, expect, it } from "vitest";
import { fmtMinutes, formatClock } from "./formatClock";

describe("formatClock", () => {
  const now = Date.UTC(2026, 9, 27, 14, 10);

  it("gives Brisbane time, lower-cased", () => {
    expect(formatClock(Date.UTC(2026, 9, 27, 13, 55), now)).toEqual({ time: "11:55 pm", rel: "−15 min" });
    expect(formatClock(Date.UTC(2026, 9, 27, 14, 5), now).time).toBe("12:05 am");
  });

  it("gives the age relative to now", () => {
    expect(formatClock(now - 30_000, now).rel).toBe("now");
    expect(formatClock(now - 65 * 60_000, now).rel).toBe("−1 h 05 min");
  });

  it("reads a forecast lead past an hour as hours and minutes", () => {
    const newest = now - 10 * 60_000;
    expect(formatClock(newest + 85 * 60_000, now, newest).rel).toBe("+1 h 25 min forecast");
    expect(formatClock(newest + 25 * 60_000, now, newest).rel).toBe("+25 min forecast");
  });
});

describe("fmtMinutes", () => {
  it("is plain minutes under an hour, else hours and minutes", () => {
    expect(fmtMinutes(25)).toBe("25 min");
    expect(fmtMinutes(130)).toBe("2 h 10 min");
    expect(fmtMinutes(65)).toBe("1 h 05 min");
  });
});
