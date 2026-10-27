import { describe, expect, it } from "vitest";
import type { ProductId } from "../../shared/config";
import { msToStamp } from "../../shared/stamps";
import type { Manifest } from "../../shared/types";
import { chooseRadar, STALE_SWITCH_MS, STALE_WARN_MS } from "./chooseRadar";

const NOW = Date.UTC(2026, 9, 28, 3, 0);
const MIN = 60_000;

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
    expect(chooseRadar({ marburg: manifest("IDR504", 5), stapylton: manifest("IDR663", 1) }, NOW)).toEqual({
      radar: "marburg", status: "ok", newestMs: NOW - 5 * MIN,
    });
  });

  it("Marburg 25 min old, Stapylton 5 min -> stapylton/ok", () => {
    expect(chooseRadar({ marburg: manifest("IDR504", 25), stapylton: manifest("IDR663", 5) }, NOW)).toEqual({
      radar: "stapylton", status: "ok", newestMs: NOW - 5 * MIN,
    });
  });

  it("both 40 min old -> marburg/stale", () => {
    expect(chooseRadar({ marburg: manifest("IDR504", 40), stapylton: manifest("IDR663", 40) }, NOW)).toEqual({
      radar: "marburg", status: "stale", newestMs: NOW - 40 * MIN,
    });
  });

  it("both empty or null -> marburg/empty with newestMs null", () => {
    const empty = { radar: "marburg", status: "empty", newestMs: null };
    expect(chooseRadar({ marburg: null, stapylton: null }, NOW)).toEqual(empty);
    expect(chooseRadar({ marburg: manifest("IDR504", null), stapylton: manifest("IDR663", null) }, NOW)).toEqual(empty);
    expect(chooseRadar({ marburg: manifest("IDR504", null), stapylton: null }, NOW)).toEqual(empty);
  });

  it("Marburg missing (null or no frames) with a fresh Stapylton -> stapylton/ok", () => {
    expect(chooseRadar({ marburg: null, stapylton: manifest("IDR663", 3) }, NOW).radar).toBe("stapylton");
    expect(chooseRadar({ marburg: manifest("IDR504", null), stapylton: manifest("IDR663", 3) }, NOW)).toEqual({
      radar: "stapylton", status: "ok", newestMs: NOW - 3 * MIN,
    });
  });

  it("exactly 20 min old is still ok; just over switches", () => {
    const at20 = { marburg: manifest("IDR504", 20), stapylton: manifest("IDR663", 1) };
    expect(chooseRadar(at20, NOW).radar).toBe("marburg");
    expect(chooseRadar(at20, NOW + 1).radar).toBe("stapylton");
  });

  it("both stale: the fresher one is used (stale), ties go to Marburg", () => {
    expect(chooseRadar({ marburg: manifest("IDR504", 90), stapylton: manifest("IDR663", 40) }, NOW)).toEqual({
      radar: "stapylton", status: "stale", newestMs: NOW - 40 * MIN,
    });
    expect(chooseRadar({ marburg: manifest("IDR504", 40), stapylton: null }, NOW).status).toBe("stale");
  });
});
