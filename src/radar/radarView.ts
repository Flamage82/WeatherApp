import type { Map as MlMap } from "maplibre-gl";
import { RADARS, type ProductId } from "../../shared/config";
import { FrameStore } from "../data/frameStore";
import { pickRange } from "../geo/pickRange";
import { RadarLayer } from "../render/radarLayer";

/** Range-change crossfade length (spec §7.5). */
export const CROSSFADE_MS = 300;

type Slot = { product: ProductId; layer: RadarLayer; drawn: boolean };

/**
 * Keeps the map's radar layer in step with the store and the view:
 *
 * - Draws `store.getPair(product, t)` on the current layer; when a pair isn't decoded yet the layer
 *   keeps its last pair, so the map never goes blank.
 * - Range choice: `pickRange` over the active radar's geometries, re-run on `moveend` and on store
 *   changes (a radar switch changes the geometries). A different product becomes the *next* slot:
 *   `ensureProduct`, wait until it has a pair, then crossfade over CROSSFADE_MS with
 *   `RadarLayer.setCrossfade` and finish by the hand-off contract (remove current, add next).
 *   While a fade runs, picks are deferred to its end. Panning within the same range does nothing.
 * - `t === null` means live: the newest loaded frame. A `t` past it draws the store's nowcast.
 */
export class RadarView {
  private cur: Slot | null = null;
  private next: Slot | null = null;
  private fadeStart: number | null = null;
  private raf = 0;
  private t: number | null = null;

  constructor(
    private readonly map: MlMap,
    private readonly store: FrameStore,
    /** Adds a layer at the right place in the style (under the labels). */
    private readonly addLayer: (l: RadarLayer) => void,
    /** Called when the displayed product changes (a fade finished). */
    private readonly onProduct: () => void = () => {},
  ) {}

  /** The layer that belongs on the map (re-added after a style change). */
  get layer(): RadarLayer | null {
    return this.cur?.layer ?? null;
  }

  get product(): ProductId | null {
    return this.cur?.product ?? null;
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
    this.repick();
    this.draw();
  }

  onMoveEnd(): void {
    this.repick();
    this.draw();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.next?.layer.releaseTextures();
    this.cur?.layer.releaseTextures();
    this.cur = this.next = null;
  }

  private wanted(): ProductId | null {
    const radar = this.store.radar;
    if (!radar) return null;
    const geoms = this.store.geometries();
    // Metas arrive one by one; picking over a partial list would pull in ranges we don't need.
    if (geoms.length < RADARS[radar].products.length) {
      const cur = this.cur?.product;
      return cur && RADARS[radar].products.includes(cur) ? cur : FrameStore.startProduct(radar);
    }
    const b = this.map.getBounds();
    return pickRange({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }, geoms);
  }

  private repick(): void {
    if (this.fadeStart !== null) return; // re-run when the fade ends
    const want = this.wanted();
    if (!want) return;
    this.store.ensureProduct(want); // idempotent; retried here if the store wasn't ready before
    if (!this.cur) {
      // First product: draw on a layer straight away, no fade.
      this.cur = { product: want, layer: new RadarLayer(), drawn: false };
      this.addLayer(this.cur.layer);
      return;
    }
    if (want === this.cur.product) {
      if (this.next) this.discardNext(); // zoomed back before the new range was ready
      return;
    }
    if (this.next?.product === want) return;
    if (this.next) this.discardNext();
    this.next = { product: want, layer: new RadarLayer(), drawn: false };
  }

  private discardNext(): void {
    this.next?.layer.releaseTextures();
    this.next = null;
  }

  private drawSlot(s: Slot, t: number): void {
    const g = this.store.geometry(s.product);
    if (g && s.layer.geometry !== g) s.layer.setGeometry(g);
    const pair = this.store.getPair(s.product, t);
    if (pair && s.layer.geometry) {
      s.layer.setPair(pair.a, pair.b, pair.flow, pair.alpha, pair.forecastLeadMs ?? 0);
      s.drawn = true;
    }
  }

  private draw(): void {
    const t = this.time();
    if (this.cur) this.drawSlot(this.cur, t);
    if (this.next) this.drawSlot(this.next, t);
    if (this.cur && this.next?.drawn && this.fadeStart === null) {
      // Nothing on screen yet (or a radar switch with no old picture): swap without a fade.
      if (!this.cur.drawn) this.finishFade();
      else this.startFade();
    }
  }

  private startFade(): void {
    this.fadeStart = performance.now();
    const tick = () => {
      if (!this.cur || !this.next || this.fadeStart === null) return;
      const mix = Math.min(1, (performance.now() - this.fadeStart) / CROSSFADE_MS);
      this.cur.layer.setCrossfade(this.next.layer, mix);
      if (mix >= 1) this.finishFade();
      else this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  /** Hand-off per RadarLayer's contract: remove the current layer, then add the target. */
  private finishFade(): void {
    const old = this.cur!, nxt = this.next!;
    this.fadeStart = null;
    if (this.map.getLayer(old.layer.id)) this.map.removeLayer(old.layer.id);
    else old.layer.releaseTextures();
    this.cur = nxt;
    this.next = null;
    this.addLayer(nxt.layer);
    this.onProduct();
    // Picks were deferred during the fade; the view or radar may have changed meanwhile.
    this.repick();
    this.draw();
  }
}
