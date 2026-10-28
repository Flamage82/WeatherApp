export const HOME = { lat: -27.67217111736596, lon: 152.49661614726207 };

export type ProductId =
  | "IDR501"
  | "IDR502"
  | "IDR503"
  | "IDR504"
  | "IDR661"
  | "IDR662"
  | "IDR663"
  | "IDR664";

export const PRODUCTS: readonly ProductId[] = [
  "IDR501",
  "IDR502",
  "IDR503",
  "IDR504",
  "IDR661",
  "IDR662",
  "IDR663",
  "IDR664",
];

/** Edge length, in 512-grid pixels, of the native cells BOM replicates onto the frame grid. */
export type CellSize = 1 | 2 | 4;

/**
 * Native cell size per product. Every product replicates 2x2 cells, aligned to even pixels
 * (phase 0: cell c covers pixels 2c and 2c+1), so interpolation runs between cell centres.
 *
 * Measured 2026-10-27 on 8 frames per product spread over the day's manifest (06:00-09:00 UTC,
 * widespread rain), with the equal-adjacent-pair test: the share of rain pairs (x, x+1) with
 * equal levels, by x mod 4, horizontally / vertically:
 *   IDR501  h 100.0 46.8 100.0 46.6   v 100.0 40.0 100.0 39.8
 *   IDR502  h 100.0 56.4 100.0 56.3   v 100.0 50.6 100.0 50.6
 *   IDR503  h 100.0 49.3 100.0 49.5   v 100.0 42.2 100.0 41.2
 *   IDR504  h  99.5 54.8  99.4 55.8   v  99.2 49.7  99.7 47.5
 *   IDR661  h 100.0 46.9 100.0 47.0   v 100.0 40.3 100.0 39.9
 *   IDR662  h 100.0 49.5 100.0 50.0   v 100.0 42.8 100.0 42.4
 *   IDR663  h 100.0 51.7 100.0 52.4   v 100.0 45.0 100.0 43.6
 *   IDR664  h  99.2 56.1  99.2 56.0   v  98.8 51.3  99.4 50.7
 * ~100% at x mod 2 = 0 and ~50% at x mod 2 = 1 means k = 2, phase 0. It isn't 4: pairs starting at
 * x mod 4 = 1 would then be ~100% too. One frame per product is kept in
 * shared/__fixtures__/cells/ and checked by shared/cellSize.test.ts.
 */
export const CELL_SIZE: Record<ProductId, CellSize> = {
  IDR501: 2,
  IDR502: 2,
  IDR503: 2,
  IDR504: 2,
  IDR661: 2,
  IDR662: 2,
  IDR663: 2,
  IDR664: 2,
};

/** Products are listed widest range to sharpest. */
export const RADARS: {
  marburg: { products: ProductId[]; tapeProduct: "IDR504" };
  stapylton: { products: ProductId[]; tapeProduct: "IDR663" };
} = {
  marburg: { products: ["IDR501", "IDR502", "IDR503", "IDR504"], tapeProduct: "IDR504" },
  stapylton: { products: ["IDR661", "IDR662", "IDR663", "IDR664"], tapeProduct: "IDR663" },
};

export const MANIFEST_SPAN_MS = 86_400_000;
export const DEFAULT_WINDOW_MS = 7_200_000;
export const MAX_FLOW_GAP_MS = 900_000;
/** The nowcast runs this far past the newest frame (client-side, spec §9). */
export const NOWCAST_MAX_MS = 3_600_000;
