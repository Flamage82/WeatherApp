import type { ProductId } from "../../shared/config";
import { homePixel } from "../../shared/homeSample";
import type { RadarGeometry } from "../../shared/types";
import type { FrameStore } from "../data/frameStore";
import { sampleInterpolatedMaxInDisc } from "../motion/interpolate";
import { SERIES_STEP_MS } from "./tapeMath";

/**
 * Rain level at home every 30 s from `fromMs` to `toMs`, drawn from the decoded pairs exactly as the map
 * draws them (max over the home disc's native cells, as the server's per-frame series is). NaN outside
 * the product's frames and wherever the pair isn't decoded yet.
 */
export function buildHomeSeries(
  store: Pick<FrameStore, "frames" | "getPair">, product: ProductId, geom: RadarGeometry, fromMs: number, toMs: number,
): Float32Array {
  const out = new Float32Array(Math.floor((toMs - fromMs) / SERIES_STEP_MS) + 1).fill(NaN);
  const fr = store.frames(product);
  if (fr.length < 2) return out;
  const lo = fr[0]!, hi = fr[fr.length - 1]!;
  const { x, y, rPx } = homePixel(geom);
  for (let k = 0; k < out.length; k++) {
    const t = fromMs + k * SERIES_STEP_MS;
    if (t < lo || t > hi) continue;
    const pair = store.getPair(product, t);
    if (pair) out[k] = sampleInterpolatedMaxInDisc(pair.a, pair.b, pair.flow, pair.alpha, x, y, rPx, pair.cell);
  }
  return out;
}
