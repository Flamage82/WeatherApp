// No @types/node in this project; vitest runs in Node so the import works at runtime.
// @ts-ignore TS2591
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encode } from "fast-png";
import { decodeFrame } from "./decodeFrame";

type Rgba = [number, number, number, number];
const TRANSPARENT: Rgba = [0, 0, 0, 0];
const BLACK: Rgba = [0, 0, 0, 255];
const LIGHT: Rgba = [0xf5, 0xf5, 0xff, 255];
const DARK: Rgba = [0x28, 0, 0, 255];

/** Build a 512x512 indexed PNG whose top-left 4 pixels are `idx`, everything else index 0. */
function makePng(depth: 4 | 8, palette: Rgba[], idx: number[]): Uint8Array {
  const n = 512 * 512;
  const indices = new Uint8Array(n);
  idx.forEach((v, i) => {
    indices[i] = v;
  });
  let data: Uint8Array;
  if (depth === 8) data = indices;
  else {
    // fast-png expects packed sub-byte data (MSB first).
    data = new Uint8Array(n / 2);
    for (let i = 0; i < n; i += 2) data[i / 2] = (indices[i]! << 4) | indices[i + 1]!;
  }
  return encode({ width: 512, height: 512, data, depth, channels: 1, palette });
}

describe("decodeFrame synthetic", () => {
  for (const depth of [4, 8] as const) {
    it(`${depth}-bit: classifies by RGB, transparent and black -> 0`, () => {
      const f = decodeFrame(makePng(depth, [TRANSPARENT, BLACK, LIGHT, DARK], [0, 1, 2, 3]));
      expect(f.width).toBe(512);
      expect(f.height).toBe(512);
      expect(Array.from(f.data.slice(0, 5))).toEqual([0, 0, 1, 15, 0]);
    });

    it(`${depth}-bit: palette order does not matter`, () => {
      const a = decodeFrame(makePng(depth, [TRANSPARENT, BLACK, LIGHT, DARK], [0, 1, 2, 3]));
      // Reordered opaque entries (fast-png's encoder only writes tRNS correctly when the
      // transparent entry is index 0, as in BOM frames), indices remapped to the same colours.
      const b = decodeFrame(makePng(depth, [TRANSPARENT, DARK, BLACK, LIGHT], [0, 2, 3, 1]));
      expect(Array.from(b.data.slice(0, 4))).toEqual([0, 0, 1, 15]);
      expect(Array.from(b.data.slice(4, 12))).toEqual(Array.from(a.data.slice(4, 12)));
      // No transparent entry at all: background index is the black (no rain) colour.
      const c = decodeFrame(makePng(depth, [BLACK, DARK, LIGHT], [0, 0, 2, 1]));
      expect(Array.from(c.data.slice(0, 4))).toEqual([0, 0, 1, 15]);
    });

    it(`${depth}-bit: rows and odd columns land in the right place`, () => {
      const idx = new Array(512 * 2).fill(0);
      idx[511] = 3; // last pixel of row 0
      idx[512] = 2; // first pixel of row 1
      idx[513] = 3; // second pixel of row 1 (odd column)
      const f = decodeFrame(makePng(depth, [TRANSPARENT, BLACK, LIGHT, DARK], idx));
      expect(f.data[511]).toBe(15);
      expect(f.data[512]).toBe(1);
      expect(f.data[513]).toBe(15);
      expect(f.data[514]).toBe(0);
    });
  }

  it("rejects a non-512 frame", () => {
    const png = encode({
      width: 2,
      height: 2,
      data: new Uint8Array(4),
      depth: 8,
      channels: 1,
      palette: [TRANSPARENT],
    });
    expect(() => decodeFrame(png)).toThrow();
  });
});

// IDR083 is an 8-bit frame, IDR063 a 4-bit one (both real BOM frames, 2026-10-27).
// NOTE: the brief assumed the bottom 20 rows are an all-zero label strip. In real frames they
// are not: the 128 km radar circle reaches the bottom edge and rain there is legitimate. Only
// the top 16 banner rows are asserted to be zero.
describe.each([
  ["8-bit IDR083", "IDR083-sample.png"],
  ["4-bit IDR063", "IDR063-4bit-sample.png"],
])("decodeFrame real fixture %s", (_name, file) => {
  const f = decodeFrame(new Uint8Array((readFileSync as (u: URL) => Uint8Array)(new URL(`./__fixtures__/${file}`, import.meta.url))));

  it("has an all-zero banner (top 16 rows)", () => {
    expect(f.data.slice(0, 16 * 512).every((v) => v === 0)).toBe(true);
  });

  it("contains rain, all levels within 0..15", () => {
    expect(f.data.slice(16 * 512).some((v) => v > 0)).toBe(true);
    expect(f.data.every((v) => v <= 15)).toBe(true);
  });
});
