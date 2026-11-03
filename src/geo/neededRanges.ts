import { BLEND_PX, type ProductId } from "../../shared/config";
import { lonLatToUV, type Bounds } from "../../shared/gnomonic";
import type { RadarGeometry } from "../../shared/types";
import { edgeDist } from "../motion/nest";

const GRID = 17;

/**
 * The ranges some visible spot would show (spec §5): sample the view on a GRID x GRID lattice and walk the
 * ranges finest first at each point, marking every range whose frame holds it, until one whose
 * full-weight interior does. `geoms` and the result are finest first.
 */
export function neededRanges(view: Bounds, geoms: RadarGeometry[]): ProductId[] {
  const needed = new Set<ProductId>();
  for (let i = 0; i < GRID; i++) {
    const lon = view.west + ((view.east - view.west) * i) / (GRID - 1);
    for (let j = 0; j < GRID; j++) {
      const lat = view.south + ((view.north - view.south) * j) / (GRID - 1);
      for (const g of geoms) {
        const { u, v } = lonLatToUV(g, lon, lat);
        const d = edgeDist(u * 512 - 0.5, v * 512 - 0.5);
        if (d < 0) continue;
        needed.add(g.product);
        if (d >= BLEND_PX[g.product]) break;
      }
    }
  }
  return geoms.map((g) => g.product).filter((p) => needed.has(p));
}
