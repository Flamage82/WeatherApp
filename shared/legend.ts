/**
 * BOM radar rain-rate legend (15 levels), classified by RGB, never by palette index.
 *
 * Verified 2026-10-27:
 *  - RGB values: all 15 match the swatches in BOM's legend image
 *    ftp://ftp.bom.gov.au/anon/gen/radar_transparencies/IDR.legend.0.png (exact), and every one
 *    also occurs in live frames (59 IDRnn3 frames across Australia). The only other opaque
 *    colours in those frames were #c0c0c0 and #000000 (banner text), so these are no rain.
 *  - mm/h: BOM's legend image only labels Light/Moderate/Heavy, with no numbers, so the rates
 *    are the design spec's §4.1 table, unverified against a BOM source. They only affect
 *    display scaling.
 */
export const BOM_LEGEND: { rgb: number; level: number; mmh: number }[] = [
  { rgb: 0xf5f5ff, level: 1, mmh: 0.2 },
  { rgb: 0xb4b4ff, level: 2, mmh: 0.5 },
  { rgb: 0x7878ff, level: 3, mmh: 1.5 },
  { rgb: 0x1414ff, level: 4, mmh: 2.5 },
  { rgb: 0x00d8c3, level: 5, mmh: 4 },
  { rgb: 0x009690, level: 6, mmh: 6 },
  { rgb: 0x006666, level: 7, mmh: 10 },
  { rgb: 0xffff00, level: 8, mmh: 15 },
  { rgb: 0xffc800, level: 9, mmh: 20 },
  { rgb: 0xff9600, level: 10, mmh: 35 },
  { rgb: 0xff6400, level: 11, mmh: 50 },
  { rgb: 0xff0000, level: 12, mmh: 80 },
  { rgb: 0xc80000, level: 13, mmh: 120 },
  { rgb: 0x780000, level: 14, mmh: 200 },
  { rgb: 0x280000, level: 15, mmh: 360 },
];

const LEVEL_BY_RGB = new Map<number, number>(BOM_LEGEND.map((e) => [e.rgb, e.level]));

/** Legend level 1..15 for an exact RGB match; 0 for anything else (no rain, banner text, etc.). */
export function rgbToLevel(r: number, g: number, b: number): number {
  return LEVEL_BY_RGB.get(((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) ?? 0;
}
