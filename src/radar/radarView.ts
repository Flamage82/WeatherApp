import type { Map as MlMap } from "maplibre-gl";
import { RADARS, type ProductId } from "../../shared/config";
import { FrameStore, type FramePair } from "../data/frameStore";
import { neededRanges } from "../geo/neededRanges";
import { isFresh } from "../motion/nest";
import { MAX_SLOTS, RadarLayer, type LayerSlot } from "../render/radarLayer";

/**
 * Whether a slot's pair counts as data at `t`. A pair the store just returned for `t` is current by
 * definition (a nowcast pair is stamped with the newest frame twice, so `isFresh` alone would call it stale
 * past +5 min); only a kept pair, held over from an earlier draw, is held to the tolerance.
 */
export function pairFresh(returned: boolean, kept: { fromMs: number; toMs: number }, t: number): boolean {
  return returned || isFresh(kept, t);
}

/**
 * Keeps the map's one radar layer in step with the store and the view (spec §4, §5):
 *
 * - Draws every range of the active radar at once, finest first, as the layer's slots. A range's slot
 *   is its pair at the drawn time; when that isn't decoded yet the range's last pair is kept, and the
 *   layer counts it as data only while `isFresh` (within one frame interval of the time), or as the
 *   fallback where nothing fresh covers a spot, so scrubbing into undecoded frames never blanks the map.
 * - Needed ranges: on `moveend` and on store changes, `neededRanges` for the view tells the store which
 *   ranges to load in full. Zooming only changes that set; nothing switches or fades.
 * - `t === null` means live: the tape product's newest frame. A `t` past it draws the store's nowcast.
 */
export class RadarView {
  private radarLayer: RadarLayer | null = null;
  private kept = new Map<ProductId, FramePair>();
  private neededKey = "";
  private t: number | null = null;

  constructor(
    private readonly map: MlMap,
    private readonly store: FrameStore,
    /** Adds a layer at the right place in the style (under the labels). */
    private readonly addLayer: (l: RadarLayer) => void,
  ) {}

  /** The layer that belongs on the map (re-added after a style change). */
  get layer(): RadarLayer | null {
    return this.radarLayer;
  }

  /** The time being drawn. */
  time(): number {
    return this.t ?? this.store.loadedWindow().end;
  }

  isLive(): boolean {
    return this.t === null;
  }

  setTime(t: number | null): void {
    this.t = t;
    this.draw();
  }

  onStoreChange(): void {
    this.updateNeeded();
    this.draw();
  }

  onMoveEnd(): void {
    this.updateNeeded();
    this.draw();
  }

  dispose(): void {
    this.radarLayer?.releaseTextures();
    this.radarLayer = null;
    this.kept.clear();
  }

  /**
   * Tell the store which ranges the view needs. Metas arrive one by one, and a partial list would
   * pull in ranges we don't need, so wait for all of them; the store already loads the tape product and
   * its support meanwhile.
   */
  private updateNeeded(): void {
    const radar = this.store.radar;
    if (!radar) return;
    const geoms = this.store.geometries();
    if (geoms.length < RADARS[radar].products.length) return;
    const b = this.map.getBounds();
    const needed = neededRanges(
      { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
      geoms.reverse(), // finest first
    );
    const key = `${radar}:${needed.join()}`;
    if (key === this.neededKey) return;
    this.neededKey = key;
    this.store.setNeeded(needed);
  }

  private draw(): void {
    const radar = this.store.radar;
    if (!radar) return;
    const t = this.time();
    const products = [...RADARS[radar].products].reverse(); // finest first
    for (const p of this.kept.keys()) if (!products.includes(p)) this.kept.delete(p); // radar switch
    const slots: LayerSlot[] = [];
    for (const p of products) {
      const geometry = this.store.geometry(p);
      if (!geometry) continue;
      const pair = this.store.getPair(p, t);
      if (pair) this.kept.set(p, pair);
      const k = this.kept.get(p);
      if (!k) continue;
      slots.push({
        product: p, geometry, a: k.a, b: k.b, flow: k.flow, alpha: k.alpha, leadMs: k.forecastLeadMs ?? 0,
        motion: k.motion, fresh: pairFresh(pair !== null, k, t),
      });
    }
    if (slots.length === 0) return;
    if (!this.radarLayer) {
      this.radarLayer = new RadarLayer();
      this.addLayer(this.radarLayer);
    }
    this.radarLayer.setSlots(slots.slice(0, MAX_SLOTS));
  }
}
