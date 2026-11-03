import { BLEND_PX, NOWCAST_MAX_MS, type ProductId } from "../../shared/config";
import { pixelAffine, type PixelAffine } from "../../shared/gnomonic";
import { pointPixel } from "../../shared/homeSample";
import type { LatLon, RadarGeometry } from "../../shared/types";
import type { FrameStore } from "../data/frameStore";
import type { FlowField } from "../motion/flow";
import { maxInDisc, sampleInterpolatedMaxInDisc } from "../motion/interpolate";
import { KEPT_TOLERANCE_MS, sampleNested, type NestSlot } from "../motion/nest";
import { SERIES_STEP_MS } from "./tapeMath";

/**
 * Rain level at `point` every 30 s from `fromMs` to `toMs`, drawn from the decoded pairs exactly as the map
 * draws them (max over the point's disc of native cells, as the per-frame samples are). NaN outside
 * the product's frames and wherever the pair isn't decoded yet.
 */
export function buildHomeSeries(
  store: Pick<FrameStore, "frames" | "getPair">, product: ProductId, geom: RadarGeometry, point: LatLon,
  fromMs: number, toMs: number,
): Float32Array {
  const out = new Float32Array(Math.floor((toMs - fromMs) / SERIES_STEP_MS) + 1).fill(NaN);
  const fr = store.frames(product);
  if (fr.length < 2) return out;
  const lo = fr[0]!, hi = fr[fr.length - 1]!;
  const { x, y, rPx } = pointPixel(geom, point);
  for (let k = 0; k < out.length; k++) {
    const t = fromMs + k * SERIES_STEP_MS;
    if (t < lo || t > hi) continue;
    const pair = store.getPair(product, t);
    if (pair) out[k] = sampleInterpolatedMaxInDisc(pair.a, pair.b, pair.flow, pair.alpha, x, y, rPx, pair.cell);
  }
  return out;
}

/** The nowcast at a point: `values[k]` at `fromMs` (the newest frame) + k * 30 s, to NOWCAST_MAX_MS. */
export type HomeForecast = { fromMs: number; values: Float32Array };

/**
 * One build per tape nowcast flow, which changes when the shared motion arrives, plus the newest frame of
 * every range read, and the point: `key`.
 */
const forecastMemo = new WeakMap<FlowField, { key: string; h: HomeForecast }>();

/**
 * The nested nowcast at `point`, as the map draws it (spec §6): `products` is finest first, `products[0]` the
 * tape product. Each step is the max, over the tape product's disc cell centres (as
 * `buildHomeSeries` samples the past), of `sampleNested` over the ranges' pairs at that time, each read
 * at the same spot in its own pixels. Null until the tape product has a nowcast.
 */
export function buildHomeForecast(
  store: Pick<FrameStore, "frames" | "getPair" | "geometry">, products: ProductId[], point: LatLon,
): HomeForecast | null {
  const tape = products[0];
  const geom = tape ? store.geometry(tape) : null;
  if (!tape || !geom) return null;
  const fr = store.frames(tape);
  if (fr.length < 2) return null;
  const fromMs = fr[fr.length - 1]!;
  const first = store.getPair(tape, fromMs + SERIES_STEP_MS);
  if (!first?.forecastLeadMs) return null;
  const key = [geom.product, point.lat, point.lon, fromMs, ...products.map((p) => store.frames(p).at(-1))].join();
  const memo = forecastMemo.get(first.flow);
  if (memo?.key === key) return memo.h;

  const { x, y, rPx } = pointPixel(geom, point);
  // A range stalled more than a frame interval behind the tape product would paint hours-old rain in.
  const ranges = products.flatMap((p) => {
    const g = store.geometry(p);
    const newest = store.frames(p).at(-1);
    return g && newest !== undefined && newest >= fromMs - KEPT_TOLERANCE_MS ? [{ p, affine: pixelAffine(geom, g) }] : [];
  });
  const values = new Float32Array(NOWCAST_MAX_MS / SERIES_STEP_MS + 1);
  for (let k = 0; k < values.length; k++) {
    const slots: NestSlot[] = [], affines: PixelAffine[] = [];
    for (const { p, affine } of ranges) {
      const pair = store.getPair(p, fromMs + k * SERIES_STEP_MS);
      if (!pair) continue; // no data from this range at this time
      slots.push({
        a: pair.a, b: pair.b, flow: pair.flow, alpha: pair.alpha, leadMs: pair.forecastLeadMs ?? 0,
        cell: pair.cell, band: BLEND_PX[p], motion: pair.motion, fresh: true,
      });
      affines.push(affine);
    }
    values[k] = maxInDisc(x, y, rPx, first.cell, (px, py) =>
      sampleNested(slots, affines.map((m) => ({ x: m.sx * px + m.ox, y: m.sy * py + m.oy })))?.level ?? 0);
  }
  const h = { fromMs, values };
  forecastMemo.set(first.flow, { key, h });
  return h;
}
