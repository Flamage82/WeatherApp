import type { ProductId } from "../../shared/config";
import { lonLatToUV, type Bounds } from "../../shared/gnomonic";
import type { RadarGeometry } from "../../shared/types";

function contains(g: RadarGeometry, view: Bounds): boolean {
  const mx = (view.west + view.east) / 2;
  const my = (view.south + view.north) / 2;
  const xs = [view.west, mx, view.east];
  const ys = [view.south, my, view.north];
  for (const lon of xs) {
    for (const lat of ys) {
      const { u, v } = lonLatToUV(g, lon, lat);
      if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return false;
    }
  }
  return true;
}

/** `geoms` is ordered widest to sharpest. Returns the sharpest that fully covers `view`, else the widest. */
export function pickRange(view: Bounds, geoms: RadarGeometry[]): ProductId {
  for (const g of [...geoms].reverse()) {
    if (contains(g, view)) return g.product;
  }
  return geoms[0]!.product;
}
