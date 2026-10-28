import { CELL_SIZE, HOME } from "./config";
import { lonLatToUV } from "./gnomonic";
import { rgbToLevel } from "./legend";
import type { LevelField } from "./decodeFrame";
import type { RadarGeometry } from "./types";

export const HOME_RADIUS_M = 1000;

const SIZE = 512;
const EARTH_R_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Home on the 512 grid (pixel-centre convention, pixel i has its centre at i) and the disc radius in pixels. */
export function homePixel(g: RadarGeometry): { x: number; y: number; rPx: number } {
  const { u, v } = lonLatToUV(g, HOME.lon, HOME.lat);
  const { bl, br } = g.corners;
  const dLat = (br.lat - bl.lat) * RAD;
  const dLon = (br.lon - bl.lon) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(bl.lat * RAD) * Math.cos(br.lat * RAD) * Math.sin(dLon / 2) ** 2;
  const widthM = 2 * EARTH_R_M * Math.asin(Math.sqrt(a));
  return { x: u * SIZE - 0.5, y: v * SIZE - 0.5, rPx: HOME_RADIUS_M / (widthM / SIZE) };
}

/**
 * Max level over the native cells (`cell` x `cell` pixels, aligned to multiples of `cell`) whose centre is
 * within `rPx` of (x, y). `levelAt` reads the cell's top-left pixel, so a lone 2x2 cell reads its full value.
 */
function discMax(levelAt: (px: number, py: number) => number, x: number, y: number, rPx: number, cell: number): number {
  const half = (cell - 1) / 2;
  const cx0 = Math.max(0, Math.ceil((x - rPx - half) / cell));
  const cx1 = Math.min(SIZE / cell - 1, Math.floor((x + rPx - half) / cell));
  const cy0 = Math.max(0, Math.ceil((y - rPx - half) / cell));
  const cy1 = Math.min(SIZE / cell - 1, Math.floor((y + rPx - half) / cell));
  let max = 0;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const dx = cx * cell + half - x;
      const dy = cy * cell + half - y;
      if (dx * dx + dy * dy > rPx * rPx) continue;
      max = Math.max(max, levelAt(cx * cell, cy * cell));
    }
  }
  return max;
}

export function maxLevelInDisc(f: LevelField, x: number, y: number, rPx: number, cell = 1): number {
  return discMax((px, py) => f.data[py * SIZE + px] ?? 0, x, y, rPx, cell);
}

/** The data of every chunk of `type` (IDAT may be split across several). */
function chunks(png: Uint8Array, type: string): Uint8Array[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Uint8Array[] = [];
  for (let p = 8; p + 8 <= png.length; ) {
    const len = view.getUint32(p);
    if (String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!) === type) {
      out.push(png.subarray(p + 8, p + 8 + len));
    }
    p += 12 + len;
  }
  return out;
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of parts) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Inflate just the first `need` bytes of a zlib stream, then stop. */
async function inflatePrefix(zlib: Uint8Array<ArrayBuffer>, need: number): Promise<Uint8Array> {
  const reader = new Blob([zlib]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const out = new Uint8Array(need);
  let n = 0;
  while (n < need) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.length, need - n);
    out.set(value.subarray(0, take), n);
    n += take;
  }
  await reader.cancel();
  if (n < need) throw new Error("truncated frame data");
  return out;
}

/**
 * Worker-side equivalent of `maxLevelInDisc(decodeFrame(png), ...)` around home, without a full decode:
 * inflates and un-filters only the rows down to the bottom of the disc and classifies just its cells.
 * Indexed, non-interlaced 512x512 PNGs only (BOM frames).
 */
export async function sampleHomeFromPng(png: Uint8Array, g: RadarGeometry): Promise<number> {
  const ihdr = chunks(png, "IHDR")[0];
  if (!ihdr) throw new Error("not a PNG");
  const ih = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  const depth = ihdr[8]!;
  if (ih.getUint32(0) !== SIZE || ih.getUint32(4) !== SIZE) throw new Error("unexpected frame size");
  if (ihdr[9] !== 3 || ihdr[12] !== 0) throw new Error("frame is not a non-interlaced indexed PNG");

  const plte = chunks(png, "PLTE")[0];
  if (!plte) throw new Error("frame is not an indexed (palette) PNG");
  const trns = chunks(png, "tRNS")[0];
  const levelOf = new Uint8Array(1 << depth);
  for (let i = 0; i < levelOf.length && i * 3 < plte.length; i++) {
    const alpha = trns?.[i] ?? 255;
    levelOf[i] = alpha === 0 ? 0 : rgbToLevel(plte[i * 3]!, plte[i * 3 + 1]!, plte[i * 3 + 2]!);
  }

  const { x, y, rPx } = homePixel(g);
  const cell = CELL_SIZE[g.product];
  const rowBytes = Math.ceil((SIZE * depth) / 8);
  const stride = rowBytes + 1;
  const perByte = 8 / depth;
  // The disc spans rows [firstRow, lastRow] and columns up to lastCol (one pixel of margin for cell alignment).
  const firstRow = Math.max(0, Math.floor(y - rPx) - 1);
  const lastRow = Math.min(SIZE - 1, Math.floor(y + rPx) + 1);
  const lastCol = Math.min(SIZE - 1, Math.floor(x + rPx) + 1);
  const lastByte = 1 + Math.floor(lastCol / perByte); // index within a row, after the filter byte
  const raw = await inflatePrefix(concat(chunks(png, "IDAT")), (lastRow + 1) * stride);

  // Un-filter in place, as little as possible. A pixel depends only on pixels above and to its left, so
  // columns right of the disc are never needed, and rows above the nearest None/Sub row (filter 0 or 1,
  // which ignore the row above) are not needed either. Indexed pixels are at most one byte, so bpp is 1.
  const zero = new Uint8Array(stride); // the "row above" row 0
  let r0 = firstRow;
  while (r0 > 0 && raw[r0 * stride]! > 1) r0--;
  for (let r = r0; r <= lastRow; r++) {
    const row = r * stride;
    const prev = r > 0 ? row - stride : 0;
    const U = r > 0 ? raw : zero;
    const filter = raw[row]!;
    if (filter === 0) continue;
    if (filter === 1) {
      for (let i = 2; i <= lastByte; i++) raw[row + i] = (raw[row + i]! + raw[row + i - 1]!) & 255;
    } else if (filter === 2) {
      for (let i = 1; i <= lastByte; i++) raw[row + i] = (raw[row + i]! + U[prev + i]!) & 255;
    } else if (filter === 3) {
      raw[row + 1] = (raw[row + 1]! + (U[prev + 1]! >> 1)) & 255;
      for (let i = 2; i <= lastByte; i++) raw[row + i] = (raw[row + i]! + ((raw[row + i - 1]! + U[prev + i]!) >> 1)) & 255;
    } else if (filter === 4) {
      let left = 0;
      let upLeft = 0;
      for (let i = 1; i <= lastByte; i++) {
        const up = U[prev + i]!;
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const v = (raw[row + i]! + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
        raw[row + i] = v;
        left = v;
        upLeft = up;
      }
    } else throw new Error(`bad PNG filter ${filter}`);
  }

  const mask = (1 << depth) - 1;
  return discMax(
    (px, py) => {
      const byte = raw[py * (rowBytes + 1) + 1 + Math.floor(px / perByte)]!;
      return levelOf[(byte >> (8 - depth * ((px % perByte) + 1))) & mask] ?? 0;
    },
    x,
    y,
    rPx,
    cell,
  );
}
