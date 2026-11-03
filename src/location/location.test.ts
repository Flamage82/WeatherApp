import { describe, expect, it } from "vitest";
import { BRISBANE, inCoverage, loadLocation, nearestRadar, rememberDefault, saveLocation } from "./location";

const CALVERT = { lat: -27.67217111736596, lon: 152.49661614726207 };

const reading = (value: string | null) => ({ getItem: () => value });

describe("nearestRadar", () => {
  it("picks Stapylton for Brisbane and Marburg for Calvert", () => {
    expect(nearestRadar(BRISBANE)).toBe("stapylton");
    expect(nearestRadar(CALVERT)).toBe("marburg");
  });
});

describe("inCoverage", () => {
  it("is true within 500 km of either radar and false beyond", () => {
    for (const p of [BRISBANE, CALVERT, { lat: -27.56, lon: 151.95 }, { lat: -28.02, lon: 153.4 }]) {
      expect(inCoverage(p)).toBe(true);
    }
    expect(inCoverage({ lat: -33.87, lon: 151.21 })).toBe(false);
    expect(inCoverage({ lat: -19.26, lon: 146.82 })).toBe(false);
  });
});

describe("loadLocation", () => {
  it.each([
    ["no key", null],
    ["unparsable", "{"],
    ["non-numeric lat", '{"lat":"x","lon":1,"radarOverride":null}'],
    ["out of coverage", '{"lat":-33.87,"lon":151.21,"radarOverride":null}'],
    ["unknown radar override", '{"lat":-27.5,"lon":153,"radarOverride":"brisbane"}'],
  ])("returns null for %s", (_name, value) => {
    expect(loadLocation(reading(value))).toBeNull();
  });

  it("round-trips a saved location", () => {
    let stored: string | null = null;
    const saved = { ...BRISBANE, name: "Brisbane", radarOverride: "marburg" as const };
    saveLocation({ setItem: (_k, v) => void (stored = v) }, saved);
    expect(loadLocation(reading(stored))).toEqual(saved);
  });
});

describe("rememberDefault", () => {
  const memory = () => {
    let stored: string | null = null;
    return { getItem: () => stored, setItem: (_k: string, v: string) => void (stored = v) };
  };

  it("saves Brisbane when nothing is saved, so a later open restores it instead of asking again", () => {
    const s = memory();
    rememberDefault(s);
    expect(loadLocation(s)).toEqual({ ...BRISBANE, radarOverride: null });
  });

  it("leaves an existing saved location alone", () => {
    const s = memory();
    const lowood = { lat: -27.47, lon: 152.57, name: "Lowood", radarOverride: null };
    saveLocation(s, lowood);
    rememberDefault(s);
    expect(loadLocation(s)).toEqual(lowood);
  });
});
