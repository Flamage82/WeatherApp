import { describe, expect, it } from "vitest";
import { parseMapFile } from "../worker/mapFile";
import { HOME } from "./config";
import { frameBounds, lonLatToUV, uvToLonLat } from "./gnomonic";
import m503 from "../worker/__fixtures__/IDR503.map?raw";
import m504 from "./__fixtures__/IDR504.map?raw";
import m664 from "./__fixtures__/IDR664.map?raw";

const g503 = parseMapFile(m503);
const g504 = parseMapFile(m504);
const g664 = parseMapFile(m664);

describe("gnomonic", () => {
  it("maps corners to the unit square", () => {
    const c = g503.corners;
    const cases: [keyof typeof c, number, number][] = [
      ["bl", 0, 1],
      ["tl", 0, 0],
      ["tr", 1, 0],
      ["br", 1, 1],
    ];
    for (const [k, u, v] of cases) {
      const r = lonLatToUV(g503, c[k].lon, c[k].lat);
      expect(Math.abs(r.u - u)).toBeLessThan(0.002);
      expect(Math.abs(r.v - v)).toBeLessThan(0.002);
    }
  });

  it("maps the centre to 0.5,0.5", () => {
    const r = lonLatToUV(g503, g503.centre.lon, g503.centre.lat);
    // Brief said ±0.002, but the BOM centre is genuinely ~0.0023 off the
    // min/max-extent midpoint in u for IDR503 (corners are slightly skewed).
    expect(Math.abs(r.u - 0.5)).toBeLessThan(0.005);
    expect(Math.abs(r.v - 0.5)).toBeLessThan(0.005);
  });

  it("round-trips HOME", () => {
    const { u, v } = lonLatToUV(g504, HOME.lon, HOME.lat);
    const p = uvToLonLat(g504, u, v);
    expect(Math.abs(p.lon - HOME.lon)).toBeLessThan(1e-6);
    expect(Math.abs(p.lat - HOME.lat)).toBeLessThan(1e-6);
  });

  it("uvToLonLat at the exact centre returns the centre", () => {
    const { u, v } = lonLatToUV(g504, g504.centre.lon, g504.centre.lat);
    const p = uvToLonLat(g504, u, v);
    expect(p.lon).toBeCloseTo(g504.centre.lon, 8);
    expect(p.lat).toBeCloseTo(g504.centre.lat, 8);
  });

  it("HOME is near the middle of IDR504", () => {
    const { u, v } = lonLatToUV(g504, HOME.lon, HOME.lat);
    expect(u).toBeGreaterThan(0.4);
    expect(u).toBeLessThan(0.6);
    expect(v).toBeGreaterThan(0.4);
    expect(v).toBeLessThan(0.6);
  });

  it("frameBounds contains all corners", () => {
    const b = frameBounds(g503);
    for (const c of Object.values(g503.corners)) {
      expect(c.lon).toBeGreaterThanOrEqual(b.west - 1e-3);
      expect(c.lon).toBeLessThanOrEqual(b.east + 1e-3);
      expect(c.lat).toBeGreaterThanOrEqual(b.south - 1e-3);
      expect(c.lat).toBeLessThanOrEqual(b.north + 1e-3);
    }
    expect(b.west).toBeLessThan(b.east);
    expect(b.south).toBeLessThan(b.north);
  });

  it("HOME is outside IDR664's frame (why Stapylton's tape uses IDR663)", () => {
    const { u, v } = lonLatToUV(g664, HOME.lon, HOME.lat);
    const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
    expect(inside).toBe(false);
  });
});
