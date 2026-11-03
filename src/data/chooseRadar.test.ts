import { describe, expect, it } from "vitest";
import type { ProductId } from "../../shared/config";
import { msToStamp } from "../../shared/stamps";
import type { Manifest } from "../../shared/types";
import { chooseRadar, STALE_SWITCH_MS, STALE_WARN_MS } from "./chooseRadar";

const NOW = Date.UTC(2026, 9, 28, 3, 0);
const MIN = 60_000;
const MARBURG = { radar: "marburg", manual: false } as const;
const STAPYLTON = { radar: "stapylton", manual: false } as const;

/** A manifest whose newest frame is `ageMin` minutes before NOW (one frame per 5 min for 1 h). */
function manifest(product: ProductId, ageMin: number | null): Manifest {
  const frames: string[] = [];
  if (ageMin !== null) for (let k = 12; k >= 0; k--) frames.push(msToStamp(NOW - ageMin * MIN - k * 5 * MIN));
  return { product, frames, lastFetchOk: null, lastError: null };
}

describe("chooseRadar", () => {
  it("exports the thresholds verbatim", () => {
    expect(STALE_SWITCH_MS).toBe(1_200_000);
    expect(STALE_WARN_MS).toBe(900_000);
  });

  it("Marburg 5 min old -> marburg/ok", () => {
    expect(chooseRadar({ marburg: manifest("IDR504", 5), stapylton: manifest("IDR663", 1) }, NOW, MARBURG)).toEqual({
      radar: "marburg", status: "ok", newestMs: NOW - 5 * MIN, fallback: false,
    });
  });

  it("Marburg 25 min old, Stapylton 5 min -> stapylton/ok", () => {
    expect(chooseRadar({ marburg: manifest("IDR504", 25), stapylton: manifest("IDR663", 5) }, NOW, MARBURG)).toEqual({
      radar: "stapylton", status: "ok", newestMs: NOW - 5 * MIN, fallback: true,
    });
  });

  it("both 40 min old -> marburg/stale", () => {
    expect(chooseRadar({ marburg: manifest("IDR504", 40), stapylton: manifest("IDR663", 40) }, NOW, MARBURG)).toEqual({
      radar: "marburg", status: "stale", newestMs: NOW - 40 * MIN, fallback: false,
    });
  });

  it("both empty or null -> marburg/empty with newestMs null", () => {
    const empty = { radar: "marburg", status: "empty", newestMs: null, fallback: false };
    expect(chooseRadar({ marburg: null, stapylton: null }, NOW, MARBURG)).toEqual(empty);
    expect(chooseRadar({ marburg: manifest("IDR504", null), stapylton: manifest("IDR663", null) }, NOW, MARBURG)).toEqual(empty);
    expect(chooseRadar({ marburg: manifest("IDR504", null), stapylton: null }, NOW, MARBURG)).toEqual(empty);
  });

  it("Marburg missing (null or no frames) with a fresh Stapylton -> stapylton/ok", () => {
    expect(chooseRadar({ marburg: null, stapylton: manifest("IDR663", 3) }, NOW, MARBURG).radar).toBe("stapylton");
    expect(chooseRadar({ marburg: manifest("IDR504", null), stapylton: manifest("IDR663", 3) }, NOW, MARBURG)).toEqual({
      radar: "stapylton", status: "ok", newestMs: NOW - 3 * MIN, fallback: true,
    });
  });

  it("exactly 20 min old is still ok; just over switches", () => {
    const at20 = { marburg: manifest("IDR504", 20), stapylton: manifest("IDR663", 1) };
    expect(chooseRadar(at20, NOW, MARBURG).radar).toBe("marburg");
    expect(chooseRadar(at20, NOW + 1, MARBURG).radar).toBe("stapylton");
  });

  it("both stale: the fresher one is used (stale), ties go to the preferred", () => {
    expect(chooseRadar({ marburg: manifest("IDR504", 90), stapylton: manifest("IDR663", 40) }, NOW, MARBURG)).toEqual({
      radar: "stapylton", status: "stale", newestMs: NOW - 40 * MIN, fallback: true,
    });
    expect(chooseRadar({ marburg: manifest("IDR504", 40), stapylton: null }, NOW, MARBURG).status).toBe("stale");
  });

  it("preferred Stapylton 25 min old, Marburg fresh, automatic -> marburg as a fallback", () => {
    const m = { marburg: manifest("IDR504", 3), stapylton: manifest("IDR663", 25) };
    expect(chooseRadar(m, NOW, STAPYLTON)).toEqual({ radar: "marburg", status: "ok", newestMs: NOW - 3 * MIN, fallback: true });
  });

  it("the same, but chosen by hand -> stays on stapylton, stale", () => {
    const m = { marburg: manifest("IDR504", 3), stapylton: manifest("IDR663", 25) };
    expect(chooseRadar(m, NOW, { radar: "stapylton", manual: true })).toEqual({
      radar: "stapylton", status: "stale", newestMs: NOW - 25 * MIN, fallback: false,
    });
  });

  it("by hand with no frames -> the chosen radar, empty", () => {
    const m = { marburg: manifest("IDR504", 3), stapylton: null };
    expect(chooseRadar(m, NOW, { radar: "stapylton", manual: true })).toEqual({
      radar: "stapylton", status: "empty", newestMs: null, fallback: false,
    });
  });

  it("both stale and tied, preferred Stapylton -> stapylton", () => {
    const m = { marburg: manifest("IDR504", 40), stapylton: manifest("IDR663", 40) };
    expect(chooseRadar(m, NOW, STAPYLTON).radar).toBe("stapylton");
  });
});
