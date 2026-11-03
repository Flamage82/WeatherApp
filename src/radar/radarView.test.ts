import { describe, expect, it } from "vitest";
import { pairFresh } from "./radarView";

describe("pairFresh", () => {
  const nowcast = { fromMs: 1_000_000, toMs: 1_000_000 }; // a nowcast pair is stamped with the newest frame twice
  const t30 = nowcast.toMs + 30 * 60_000;

  it("treats a pair the store returned for the drawn time as current, however far into the nowcast", () => {
    expect(pairFresh(true, nowcast, t30)).toBe(true);
  });

  it("holds a kept pair to the one-frame tolerance", () => {
    expect(pairFresh(false, nowcast, nowcast.toMs + 4 * 60_000)).toBe(true);
    expect(pairFresh(false, nowcast, t30)).toBe(false);
  });
});
