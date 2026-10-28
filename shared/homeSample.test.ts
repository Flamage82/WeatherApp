// No @types/node in this project; vitest runs in Node so the import works at runtime.
// @ts-ignore TS2591
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMapFile } from "../worker/mapFile";
import { HOME } from "./config";
import { decodeFrame, type LevelField } from "./decodeFrame";
import { homePixel, maxLevelInDisc, sampleHomeFromPng } from "./homeSample";
import m504 from "./__fixtures__/IDR504.map?raw";
import type { RadarGeometry } from "./types";

const g504 = parseMapFile(m504);

const field = (px: [number, number, number][]): LevelField => {
  const data = new Uint8Array(512 * 512);
  for (const [x, y, v] of px) data[y * 512 + x] = v;
  return { width: 512, height: 512, data };
};

describe("homePixel", () => {
  it("puts home inside the IDR504 frame with a ~250 m pixel", () => {
    const { x, y, rPx } = homePixel(g504);
    expect(x).toBeGreaterThan(204.8);
    expect(x).toBeLessThan(307.2);
    expect(y).toBeGreaterThan(204.8);
    expect(y).toBeLessThan(307.2);
    expect(Math.abs(rPx - 4)).toBeLessThan(0.3);
  });
});

describe("maxLevelInDisc", () => {
  it("reads a pixel inside the radius and ignores one outside", () => {
    expect(maxLevelInDisc(field([[260, 256, 9]]), 257, 256, 4)).toBe(9);
    expect(maxLevelInDisc(field([[263, 256, 9]]), 257, 256, 4)).toBe(0);
  });

  it("reads a lone 2x2 cell in full when only its centre is in the disc", () => {
    const f = field([[256, 256, 7], [257, 256, 7], [256, 257, 7], [257, 257, 7]]);
    // The cell centre (256.5, 256.5) is 3.5 px from x = 260; its own pixel (256, 256) is 4 px away.
    expect(maxLevelInDisc(f, 260, 256.5, 3.6, 2)).toBe(7);
  });
});

// IDR083 is an 8-bit frame, IDR063 a 4-bit one (both real BOM frames).
describe.each(["IDR083-sample.png", "IDR063-4bit-sample.png"])("sampleHomeFromPng %s", (file) => {
  const png = new Uint8Array((readFileSync as (u: URL) => Uint8Array)(new URL(`./__fixtures__/${file}`, import.meta.url)));
  const f = decodeFrame(png);

  it("equals maxLevelInDisc(decodeFrame) with home placed on rain", async () => {
    const at = f.data.findIndex((v, i) => i > 16 * 512 && v > 0);
    const [tx, ty] = [at % 512, Math.floor(at / 512)];
    // A 0.2 degree box puts ~40 px under the 1 km disc, with home landing on (tx, ty).
    const W = 0.2;
    const west = HOME.lon - (tx / 512) * W;
    const north = HOME.lat + (ty / 512) * W;
    const g: RadarGeometry = {
      ...g504,
      centre: { lon: west + W / 2, lat: north - W / 2 },
      corners: {
        bl: { lon: west, lat: north - W },
        tl: { lon: west, lat: north },
        tr: { lon: west + W, lat: north },
        br: { lon: west + W, lat: north - W },
      },
    };
    const { x, y, rPx } = homePixel(g);
    const expected = maxLevelInDisc(f, x, y, rPx, 2);
    expect(expected).toBeGreaterThan(0);
    expect(await sampleHomeFromPng(png, g)).toBe(expected);
  });
});
