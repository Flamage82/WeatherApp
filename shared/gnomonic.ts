import type { LonLat, RadarGeometry } from "./types";

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export type Bounds = { west: number; south: number; east: number; north: number };

/** Forward gnomonic about (lat0, lon0), in tangent-plane units (unit sphere). */
function forward(lat0: number, lon0: number, lon: number, lat: number): { x: number; y: number } {
  const p0 = lat0 * RAD;
  const p = lat * RAD;
  const dl = (lon - lon0) * RAD;
  const cosC = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(dl);
  return {
    x: (Math.cos(p) * Math.sin(dl)) / cosC,
    y: (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(dl)) / cosC,
  };
}

function extent(g: RadarGeometry) {
  const { lat, lon } = g.centre;
  const pts = Object.values(g.corners).map((c) => forward(lat, lon, c.lon, c.lat));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    xMin: Math.min(...xs),
    xMax: Math.max(...xs),
    yMin: Math.min(...ys),
    yMax: Math.max(...ys),
  };
}

/** u right, v down, 0..1 over the image. */
export function lonLatToUV(g: RadarGeometry, lon: number, lat: number): { u: number; v: number } {
  const { x, y } = forward(g.centre.lat, g.centre.lon, lon, lat);
  const e = extent(g);
  return {
    u: (x - e.xMin) / (e.xMax - e.xMin),
    v: (e.yMax - y) / (e.yMax - e.yMin),
  };
}

export function uvToLonLat(g: RadarGeometry, u: number, v: number): LonLat {
  const e = extent(g);
  const x = e.xMin + u * (e.xMax - e.xMin);
  const y = e.yMax - v * (e.yMax - e.yMin);
  const p0 = g.centre.lat * RAD;
  const l0 = g.centre.lon * RAD;
  const rho = Math.sqrt(x * x + y * y);
  if (rho === 0) return { lon: g.centre.lon, lat: g.centre.lat };
  const c = Math.atan(rho);
  const sinC = Math.sin(c);
  const cosC = Math.cos(c);
  const lat = Math.asin(cosC * Math.sin(p0) + (y * sinC * Math.cos(p0)) / rho);
  const lon = l0 + Math.atan2(x * sinC, rho * Math.cos(p0) * cosC - y * Math.sin(p0) * sinC);
  return { lon: lon * DEG, lat: lat * DEG };
}

/** Lon/lat bounding box of the image. Edges are curved, so sample along them. */
export function frameBounds(g: RadarGeometry): Bounds {
  const N = 16;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    for (const [u, v] of [
      [t, 0],
      [t, 1],
      [0, t],
      [1, t],
    ] as const) {
      const p = uvToLonLat(g, u, v);
      west = Math.min(west, p.lon);
      east = Math.max(east, p.lon);
      south = Math.min(south, p.lat);
      north = Math.max(north, p.lat);
    }
  }
  return { west, south, east, north };
}
