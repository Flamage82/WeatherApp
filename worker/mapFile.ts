import { PRODUCTS, type ProductId } from "../shared/config";
import type { LonLat, RadarGeometry } from "../shared/types";

const REQUIRED_KEYS = [
  "projection",
  "center_longitude",
  "center_latitude",
  "lon0",
  "lat0",
  "lon1",
  "lat1",
  "lon2",
  "lat2",
  "lon3",
  "lat3",
] as const;

/**
 * Parses a BOM radar `.map` geometry file (e.g. IDR503.map).
 *
 * Layout: line 1 is `IDR503.map`, line 2 is `50 Marburg (128 km)`, then
 * `key = value` lines. Corners: lon0/lat0 = bl, lon1/lat1 = tl,
 * lon2/lat2 = tr, lon3/lat3 = br.
 */
export function parseMapFile(text: string): RadarGeometry {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const headerMatch = /^(IDR\d{3})\.map$/.exec(lines[0] ?? "");
  if (!headerMatch) {
    throw new Error(`Map file: expected a first line like "IDR503.map", got "${lines[0] ?? ""}"`);
  }
  const product = headerMatch[1] as ProductId;
  if (!PRODUCTS.includes(product)) {
    throw new Error(`Map file: unknown product "${product}"`);
  }

  const nameMatch = /^\d+\s+(.+)$/.exec(lines[1] ?? "");
  if (!nameMatch) {
    throw new Error(`Map file: expected a name line like "50 Marburg (128 km)", got "${lines[1] ?? ""}"`);
  }
  const name = (nameMatch[1] ?? "").trim();

  const values = new Map<string, string>();
  for (const line of lines.slice(2)) {
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (kv && kv[1] !== undefined) values.set(kv[1], (kv[2] ?? "").trim());
  }

  for (const key of REQUIRED_KEYS) {
    if (!values.has(key)) {
      throw new Error(`Map file: missing required key "${key}"`);
    }
  }

  const projection = values.get("projection")!;
  if (projection !== "Gnomonic") {
    throw new Error(`Map file: unsupported projection "${projection}" (expected Gnomonic)`);
  }

  const num = (key: string): number => {
    const n = Number(values.get(key));
    if (!Number.isFinite(n)) {
      throw new Error(`Map file: key "${key}" is not a number ("${values.get(key)}")`);
    }
    return n;
  };
  const point = (lonKey: string, latKey: string): LonLat => ({
    lon: num(lonKey),
    lat: num(latKey),
  });

  return {
    product,
    name,
    centre: point("center_longitude", "center_latitude"),
    corners: {
      bl: point("lon0", "lat0"),
      tl: point("lon1", "lat1"),
      tr: point("lon2", "lat2"),
      br: point("lon3", "lat3"),
    },
  };
}
