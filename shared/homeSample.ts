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
  const lastRow = Math.min(SIZE - 1, Math.floor(y + rPx) + 1);
  const raw = await inflatePrefix(concat(chunks(png, "IDAT")), (lastRow + 1) * (rowBytes + 1));

  // Un-filter in place; indexed pixels are at most one byte, so bpp is 1.
  for (let r = 0; r <= lastRow; r++) {
    const row = r * (rowBytes + 1);
    const filter = raw[row]!;
    for (let i = 1; i <= rowBytes; i++) {
      const left = i > 1 ? raw[row + i - 1]! : 0;
      const up = r > 0 ? raw[row - rowBytes - 1 + i]! : 0;
      const upLeft = r > 0 && i > 1 ? raw[row - rowBytes - 1 + i - 1]! : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      raw[row + i] = (raw[row + i]! + add) & 255;
    }
  }

  const perByte = 8 / depth;
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
