import { NOWCAST_MAX_MS, type ProductId } from "../../shared/config";
import { homePixel } from "../../shared/homeSample";
import type { RadarGeometry } from "../../shared/types";
import type { FrameStore } from "../data/frameStore";
import type { FlowField } from "../motion/flow";
import { sampleForecastMaxInDisc, sampleInterpolatedMaxInDisc } from "../motion/interpolate";
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

/** The nowcast at home: `values[k]` at `fromMs` (the newest frame) + k * 30 s, to NOWCAST_MAX_MS. */
export type HomeForecast = { fromMs: number; values: Float32Array };

/** One build per forecast flow (the store makes one per newest frame and pair count). */
const forecastMemo = new WeakMap<FlowField, { geom: RadarGeometry; h: HomeForecast }>();

/**
 * The nowcast at home from the product's newest frame, sampled as `buildHomeSeries` samples the past
 * (max over the home disc's native cells). Null until the store has a nowcast for the product.
 */
export function buildHomeForecast(
  store: Pick<FrameStore, "frames" | "getPair">, product: ProductId, geom: RadarGeometry,
): HomeForecast | null {
  const fr = store.frames(product);
  if (fr.length < 2) return null;
  const fromMs = fr[fr.length - 1]!;
  const pair = store.getPair(product, fromMs + SERIES_STEP_MS);
  if (!pair?.forecastLeadMs) return null;
  const memo = forecastMemo.get(pair.flow);
  if (memo && memo.geom === geom && memo.h.fromMs === fromMs) return memo.h;
  const { x, y, rPx } = homePixel(geom);
  const values = new Float32Array(NOWCAST_MAX_MS / SERIES_STEP_MS + 1);
  for (let k = 0; k < values.length; k++) {
    values[k] = sampleForecastMaxInDisc(pair.a, pair.flow, k * SERIES_STEP_MS, x, y, rPx, pair.cell);
  }
  const h = { fromMs, values };
  forecastMemo.set(pair.flow, { geom, h });
  return h;
}
