import { describe, expect, it } from "vitest";
import { parseMapFile } from "../../worker/mapFile";
import { HOME } from "../../shared/config";
import { frameBounds, uvToLonLat, type Bounds } from "../../shared/gnomonic";
import { neededRanges } from "./neededRanges";
import m501 from "../../shared/__fixtures__/IDR501.map?raw";
import m502 from "../../shared/__fixtures__/IDR502.map?raw";
import m503 from "../../worker/__fixtures__/IDR503.map?raw";
import m504 from "../../shared/__fixtures__/IDR504.map?raw";

const [g501, g502, g503, g504] = [m501, m502, m503, m504].map(parseMapFile) as [
  ReturnType<typeof parseMapFile>, ReturnType<typeof parseMapFile>,
  ReturnType<typeof parseMapFile>, ReturnType<typeof parseMapFile>,
];
const finestFirst = [g504, g503, g502, g501];

const KM_LAT = 1 / 111.2;
/** A square box `km` wide centred on a lon/lat. */
function box(lon: number, lat: number, km: number): Bounds {
  const dLat = (km / 2) * KM_LAT, dLon = dLat / Math.cos((lat * Math.PI) / 180);
  return { west: lon - dLon, east: lon + dLon, south: lat - dLat, north: lat + dLat };
}

describe("neededRanges", () => {
  it("needs only the finest range for a small view around HOME", () => {
    expect(neededRanges(box(HOME.lon, HOME.lat, 20), finestFirst)).toEqual(["IDR504"]);
  });

  it("needs every range that shows somewhere when the view is the 128 km frame's bounds", () => {
    expect(neededRanges(frameBounds(g503), finestFirst)).toEqual(["IDR504", "IDR503", "IDR502"]);
  });

  it("needs a coarse range alone where no finer frame reaches", () => {
    const c = g503.centre;
    const lon = c.lon + 200 / (111.2 * Math.cos((c.lat * Math.PI) / 180));
    expect(neededRanges(box(lon, c.lat, 20), finestFirst)).toEqual(["IDR502"]);
  });

  it("needs both ranges across a finer range's blend band", () => {
    const edge = uvToLonLat(g504, 1 - 16 / 512, 0.5); // the east edge of its data, inside the 16 px border
    expect(neededRanges(box(edge.lon, edge.lat, 10), finestFirst)).toEqual(["IDR504", "IDR503"]);
  });
});
