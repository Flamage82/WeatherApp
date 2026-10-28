import type { ProductId } from "./config";

export type Manifest = {
  product: ProductId;
  /** Ascending `YYYYMMDDHHMM` UTC stamps. */
  frames: string[];
  /** ISO timestamp of the last successful fetch. */
  lastFetchOk: string | null;
  lastError: string | null;
};

/** `/api/series/:product/:day`: rain level (0..15) in the disc around home, per frame. */
export type SeriesDay = {
  product: ProductId;
  day: string;
  /** Ascending, unique `YYYYMMDDHHMM` UTC stamps. Frames ingested without a home sample are omitted. */
  points: [stamp: string, level: number][];
};

export type LonLat = { lon: number; lat: number };

export type RadarGeometry = {
  product: ProductId;
  name: string;
  centre: { lat: number; lon: number };
  corners: { bl: LonLat; tl: LonLat; tr: LonLat; br: LonLat };
};
