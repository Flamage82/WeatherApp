import { RADARS, type ProductId } from "../../shared/config";
import { pointPixel } from "../../shared/homeSample";
import type { LatLon, RadarGeometry } from "../../shared/types";
import type { RadarName } from "./chooseRadar";

const LAST_PIXEL = 511;

/**
 * The tape product: the finest range of `radar` whose frame holds the point's whole 1 km disc, judged from
 * the geometries loaded so far. Ranges without geometry are skipped; with none loaded this is the widest
 * range, and the caller re-asks once geometry arrives.
 */
export function chooseTapeProduct(
  radar: RadarName, p: LatLon, geometry: (id: ProductId) => RadarGeometry | null,
): ProductId {
  const { products } = RADARS[radar];
  for (const id of [...products].reverse()) {
    const g = geometry(id);
    if (!g) continue;
    const { x, y, rPx } = pointPixel(g, p);
    if (x - rPx >= 0 && x + rPx <= LAST_PIXEL && y - rPx >= 0 && y + rPx <= LAST_PIXEL) return id;
  }
  return products[0]!;
}
