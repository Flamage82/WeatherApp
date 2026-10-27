import type { ProductId } from "./config";

export type Manifest = {
  product: ProductId;
  /** Ascending `YYYYMMDDHHMM` UTC stamps. */
  frames: string[];
  /** ISO timestamp of the last successful fetch. */
  lastFetchOk: string | null;
  lastError: string | null;
};

export type LonLat = { lon: number; lat: number };

export type RadarGeometry = {
  product: ProductId;
  name: string;
  centre: { lat: number; lon: number };
  corners: { bl: LonLat; tl: LonLat; tr: LonLat; br: LonLat };
};
