import { describe, it, expect } from "vitest";
import { RAMP_STOPS, buildRampLUT, rampColour } from "./colourRamp";

const hex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

describe("RAMP_STOPS", () => {
  it("are the spec 7.2 stops", () => {
    expect(RAMP_STOPS).toEqual([
      { level: 1, rgb: "#81d4fa", alpha: 0.35 },
      { level: 3, rgb: "#29b6f6", alpha: 0.75 },
      { level: 5, rgb: "#43a047", alpha: 1 },
      { level: 8, rgb: "#fdd835", alpha: 1 },
      { level: 10, rgb: "#fb8c00", alpha: 1 },
      { level: 12, rgb: "#e53935", alpha: 1 },
      { level: 15, rgb: "#d81b9a", alpha: 1 },
    ]);
  });
});

describe("rampColour", () => {
  it("is fully transparent at level 0 (and below)", () => {
    expect(rampColour(0)[3]).toBe(0);
    expect(rampColour(-3)[3]).toBe(0);
  });

  it("is #d81b9a, opaque, at level 15 (and above)", () => {
    expect(rampColour(15)).toEqual([0xd8, 0x1b, 0x9a, 255]);
    expect(rampColour(20)).toEqual([0xd8, 0x1b, 0x9a, 255]);
  });

  it("hits every stop exactly", () => {
    expect(rampColour(1)).toEqual([0x81, 0xd4, 0xfa, 89]);
    expect(rampColour(3)).toEqual([0x29, 0xb6, 0xf6, 191]);
    expect(rampColour(5)).toEqual([0x43, 0xa0, 0x47, 255]);
    expect(rampColour(8)).toEqual([0xfd, 0xd8, 0x35, 255]);
    expect(rampColour(10)).toEqual([0xfb, 0x8c, 0x00, 255]);
    expect(rampColour(12)).toEqual([0xe5, 0x39, 0x35, 255]);
    expect(rampColour(15)).toEqual([0xd8, 0x1b, 0x9a, 255]);
  });

  it("interpolates RGB and alpha linearly between stops", () => {
    // Halfway between level 1 (#81d4fa, 0.35) and level 3 (#29b6f6, 0.75).
    expect(rampColour(2)).toEqual([
      Math.round((0x81 + 0x29) / 2),
      Math.round((0xd4 + 0xb6) / 2),
      Math.round((0xfa + 0xf6) / 2),
      Math.round(0.55 * 255),
    ]);
  });

  it("fades the first stop's colour to transparent below level 1", () => {
    const c = rampColour(0.5);
    expect(c.slice(0, 3)).toEqual(hex("#81d4fa"));
    expect(c[3]).toBe(Math.round(0.175 * 255));
  });

  it("alpha never decreases with level, and is opaque from level 5 up", () => {
    let prev = -1;
    for (let l = 0; l <= 15; l += 0.25) {
      const a = rampColour(l)[3];
      expect(a).toBeGreaterThanOrEqual(prev);
      if (l >= 5) expect(a).toBe(255);
      prev = a;
    }
  });

  it("gets 'hotter' monotonically: stop order runs blue -> green -> yellow -> orange -> red -> magenta", () => {
    const at = RAMP_STOPS.map((s) => rampColour(s.level));
    // Blue stops: blue channel dominant.
    for (const c of at.slice(0, 2)) expect(c[2]).toBeGreaterThan(c[0]);
    // Green: green dominant.
    expect(at[2]![1]).toBeGreaterThan(at[2]![0]);
    expect(at[2]![1]).toBeGreaterThan(at[2]![2]);
    // Yellow -> orange -> red: red stays high while green falls.
    expect(at[3]![1]).toBeGreaterThan(at[4]![1]);
    expect(at[4]![1]).toBeGreaterThan(at[5]![1]);
    for (const c of at.slice(3, 6)) expect(c[0]).toBeGreaterThan(200);
    // Magenta: blue rises again past red.
    expect(at[6]![2]).toBeGreaterThan(at[5]![2]);
  });
});

describe("buildRampLUT", () => {
  const lut = buildRampLUT();

  it("is 256 RGBA entries", () => {
    expect(lut).toBeInstanceOf(Uint8Array);
    expect(lut.length).toBe(256 * 4);
  });

  it("indexes by round(level/15*255): level 1 is entry 17 with alpha ~89", () => {
    const i = Math.round((1 / 15) * 255);
    expect(i).toBe(17);
    expect(lut[i * 4 + 3]).toBeCloseTo(89, 0);
    expect(Array.from(lut.slice(i * 4, i * 4 + 4))).toEqual(rampColour(1));
  });

  it("matches rampColour at every entry", () => {
    for (let i = 0; i < 256; i++) {
      expect(Array.from(lut.slice(i * 4, i * 4 + 4))).toEqual(rampColour((i / 255) * 15));
    }
  });

  it("is transparent at entry 0 and #d81b9a opaque at entry 255", () => {
    expect(lut[3]).toBe(0);
    expect(Array.from(lut.slice(255 * 4))).toEqual([0xd8, 0x1b, 0x9a, 255]);
  });
});
