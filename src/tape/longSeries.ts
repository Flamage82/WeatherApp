import type { ProductId } from "../../shared/config";
import { msToStamp } from "../../shared/stamps";
import type { LatLon, RadarGeometry } from "../../shared/types";
import type { SeriesPoint } from "./tapeMath";

/** A frame that failed to fetch or sample is tried again by a `points` call this long after. */
const RETRY_MS = 30_000;
const DEFAULT_CONCURRENCY = 4;

type Deps = {
  fetchFrame(p: ProductId, stamp: string): Promise<Uint8Array>;
  sample(png: Uint8Array, g: RadarGeometry, point: LatLon): Promise<number>;
  /** Called as each frame's sample lands (or fails), so the tape can redraw. */
  onUpdate(): void;
  concurrency?: number;
};

/**
 * The tape's long spans (movable-location spec §8): one rain level per frame at a point, sampled on the
 * phone. `points` returns what has landed for the range asked about and queues the rest, nearest the
 * playhead first, with at most `concurrency` frames in flight. Each call replaces the queue, so work for
 * a range that has scrolled away is dropped. Results are kept per product and point: asking for another
 * discards them.
 */
export class LongSeries {
  private readonly deps: Deps;
  private readonly concurrency: number;
  private key = "";
  /** Bumped when the product or point changes, so results still in flight for the old one are ignored. */
  private gen = 0;
  private geometry: RadarGeometry | null = null;
  private point: LatLon | null = null;
  private product: ProductId | null = null;
  private levels = new Map<number, number>();
  private inFlight = new Set<number>();
  private failed = new Map<number, number>();
  private queue: number[] = [];

  constructor(deps: Deps) {
    this.deps = deps;
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  }

  points(
    p: ProductId, g: RadarGeometry, point: LatLon, stamps: number[], fromMs: number, toMs: number, centreMs: number,
  ): { points: SeriesPoint[]; pending: boolean } {
    const key = `${p}|${point.lat}|${point.lon}`;
    if (key !== this.key) {
      this.key = key;
      this.gen++;
      this.levels.clear();
      this.inFlight.clear();
      this.failed.clear();
      this.queue = [];
    }
    this.product = p;
    this.geometry = g;
    this.point = point;

    const now = Date.now();
    const inRange = stamps.filter((ms) => ms >= fromMs && ms <= toMs);
    const retryable = (ms: number) => {
      const at = this.failed.get(ms);
      return at === undefined || now - at >= RETRY_MS;
    };
    const wanted = inRange.filter((ms) => !this.levels.has(ms) && !this.inFlight.has(ms) && retryable(ms));
    this.queue = wanted.sort((a, b) => Math.abs(a - centreMs) - Math.abs(b - centreMs));
    this.pump();

    return {
      points: inRange.filter((ms) => this.levels.has(ms)).map((ms) => [msToStamp(ms), this.levels.get(ms)!]),
      pending: wanted.length > 0 || inRange.some((ms) => this.inFlight.has(ms)),
    };
  }

  /** Drops the queued work (the tape isn't showing a long span any more). Frames already in flight still land. */
  cancel(): void {
    this.queue = [];
  }

  private pump(): void {
    while (this.inFlight.size < this.concurrency && this.queue.length > 0) {
      const ms = this.queue.shift()!;
      if (this.levels.has(ms) || this.inFlight.has(ms)) continue;
      void this.load(ms);
    }
  }

  private async load(ms: number): Promise<void> {
    const gen = this.gen, p = this.product!, g = this.geometry!, point = this.point!;
    this.inFlight.add(ms);
    try {
      const level = await this.deps.sample(await this.deps.fetchFrame(p, msToStamp(ms)), g, point);
      if (gen === this.gen) this.levels.set(ms, level);
    } catch (e) {
      console.warn(`long series ${p}/${msToStamp(ms)} failed`, e);
      if (gen === this.gen) this.failed.set(ms, Date.now());
    }
    if (gen !== this.gen) return;
    this.inFlight.delete(ms);
    this.deps.onUpdate();
    this.pump();
  }
}
