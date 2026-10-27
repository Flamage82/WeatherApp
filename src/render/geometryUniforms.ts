import { frameBounds } from "../../shared/gnomonic";
import type { RadarGeometry } from "../../shared/types";

const RAD = Math.PI / 180;

/**
 * Everything the fragment shader needs to go lon/lat -> gnomonic uv for one frame.
 * Mirrors `shared/gnomonic.ts` (`forward` + `extent`), which keeps those private.
 */
export type GnomonicUniforms = {
  /** Tangent point, radians. */
  lat0: number;
  lon0: number;
  /** Image extent in tangent-plane units (unit sphere). */
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

function forward(lat0: number, lon0: number, lon: number, lat: number) {
  const p0 = lat0 * RAD, p = lat * RAD, dl = (lon - lon0) * RAD;
  const cosC = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(dl);
  return {
    x: (Math.cos(p) * Math.sin(dl)) / cosC,
    y: (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(dl)) / cosC,
  };
}

export function gnomonicUniforms(g: RadarGeometry): GnomonicUniforms {
  const pts = Object.values(g.corners).map((c) => forward(g.centre.lat, g.centre.lon, c.lon, c.lat));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return {
    lat0: g.centre.lat * RAD,
    lon0: g.centre.lon * RAD,
    xMin: Math.min(...xs),
    xMax: Math.max(...xs),
    yMin: Math.min(...ys),
    yMax: Math.max(...ys),
  };
}

/** Web Mercator world coords (0..1, y down) -> lon/lat degrees. */
export function mercToLonLat(mx: number, my: number): { lon: number; lat: number } {
  return { lon: mx * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) / RAD };
}

/** lon/lat degrees -> Web Mercator world coords (same as maplibregl.MercatorCoordinate.fromLngLat). */
export function lonLatToMerc(lon: number, lat: number): { x: number; y: number } {
  const s = Math.sin(lat * RAD);
  return { x: (lon + 180) / 360, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
}

/**
 * CPU mirror of the fragment shader's Mercator -> gnomonic uv step (same formula, same order),
 * so it can be unit-tested against `lonLatToUV`.
 */
export function mercToUV(gu: GnomonicUniforms, mx: number, my: number): { u: number; v: number } {
  const lon = mx * 2 * Math.PI - Math.PI;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * my)));
  const dl = lon - gu.lon0;
  const sp0 = Math.sin(gu.lat0), cp0 = Math.cos(gu.lat0);
  const sp = Math.sin(lat), cp = Math.cos(lat);
  const cosC = sp0 * sp + cp0 * cp * Math.cos(dl);
  const x = (cp * Math.sin(dl)) / cosC;
  const y = (cp0 * sp - sp0 * cp * Math.cos(dl)) / cosC;
  return { u: (x - gu.xMin) / (gu.xMax - gu.xMin), v: (gu.yMax - y) / (gu.yMax - gu.yMin) };
}

/**
 * uv (0..1 over the image) -> full-res pixel coords in `sampleInterpolated`'s convention, where
 * pixel (ix, iy) has its value at integer (ix, iy), i.e. at its centre: u = (ix + 0.5) / 512.
 */
export function uvToPixel(u: number, v: number): { x: number; y: number } {
  return { x: u * 512 - 0.5, y: v * 512 - 0.5 };
}

/**
 * The frame's lon/lat bounding box as a Mercator quad (triangle strip: NW, SW, NE, SE), padded by
 * 1% each side: `frameBounds` samples the curved edges, so the true extreme can sit a hair
 * outside it. The fragment shader discards outside uv 0..1, so padding costs nothing visible.
 */
export function mercQuad(g: RadarGeometry): Float32Array {
  const b = frameBounds(g);
  const nw = lonLatToMerc(b.west, b.north), se = lonLatToMerc(b.east, b.south);
  const px = (se.x - nw.x) * 0.01, py = (se.y - nw.y) * 0.01;
  const x0 = nw.x - px, y0 = nw.y - py, x1 = se.x + px, y1 = se.y + py;
  return new Float32Array([x0, y0, x0, y1, x1, y0, x1, y1]);
}

/** Union of two Mercator quads from `mercQuad`. */
export function unionQuad(p: Float32Array, q: Float32Array): Float32Array {
  const x0 = Math.min(p[0]!, q[0]!), y0 = Math.min(p[1]!, q[1]!);
  const x1 = Math.max(p[6]!, q[6]!), y1 = Math.max(p[7]!, q[7]!);
  return new Float32Array([x0, y0, x0, y1, x1, y0, x1, y1]);
}
