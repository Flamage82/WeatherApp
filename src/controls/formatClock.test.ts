import { describe, expect, it } from "vitest";
import { formatClock } from "./formatClock";

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
});
