import { decode } from "fast-png";
import { rgbToLevel } from "./legend";

export type LevelField = {
  width: 512;
  height: 512;
  /** Rain level 0..15 per pixel, row-major, row 0 = top. */
  data: Uint8Array;
};

/**
 * Decode a BOM radar frame (indexed PNG, 1/2/4/8-bit, palette in arbitrary order) into rain levels.
 * Pixels are classified by palette RGB via `rgbToLevel`, never by index. Fully transparent
 * (tRNS alpha 0) entries and any non-legend colour become 0. Pure fast-png: usable in the Worker.
 *
 * fast-png returns sub-byte indexed data still packed (MSB first, rows padded to a byte), and the
 * palette as [r,g,b,a] entries with tRNS alpha folded in.
 */
export function decodeFrame(png: Uint8Array): LevelField {
  const img = decode(png);
  const { width, height, depth, palette } = img;
  if (width !== 512 || height !== 512) throw new Error(`unexpected frame size ${width}x${height}`);
  if (!palette || img.channels !== 1) throw new Error("frame is not an indexed (palette) PNG");

  // Level per palette index, computed once.
  const levelOf = new Uint8Array(1 << depth);
  palette.forEach((p, i) => {
    if (i >= levelOf.length) return;
    const alpha = p[3] ?? 255;
    levelOf[i] = alpha === 0 ? 0 : rgbToLevel(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
  });

  const out = new Uint8Array(width * height);
  const src = img.data as Uint8Array;
  if (depth === 8) {
    for (let i = 0; i < out.length; i++) out[i] = levelOf[src[i] ?? 0] ?? 0;
  } else {
    const perByte = 8 / depth;
    const mask = (1 << depth) - 1;
    const rowBytes = Math.ceil((width * depth) / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = src[y * rowBytes + Math.floor(x / perByte)] ?? 0;
        const shift = 8 - depth * ((x % perByte) + 1);
        out[y * width + x] = levelOf[(byte >> shift) & mask] ?? 0;
      }
    }
  }
  return { width: 512, height: 512, data: out };
}
