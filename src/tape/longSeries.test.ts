import { describe, expect, it, vi } from "vitest";
import { msToStamp } from "../../shared/stamps";
import type { RadarGeometry } from "../../shared/types";
import { LongSeries } from "./longSeries";

const T0 = Date.UTC(2026, 10, 3, 0, 0);
const STEP = 300_000;
const stamps = Array.from({ length: 10 }, (_, i) => T0 + i * STEP);
const GEOM = { product: "IDR504" } as RadarGeometry;
const NEAR = { lat: -27.47, lon: 153.03 };
const FAR = { lat: -27.67, lon: 152.5 };

/** A LongSeries whose frame fetches resolve only when the test says so; a frame's level is its index. */
function setup(concurrency = 2) {
  const waiting: { ms: number; resolve(): void }[] = [];
  const fetched: number[] = [];
  const fetchFrame = vi.fn((_p: string, stamp: string) => {
    const ms = stamps.find((s) => msToStamp(s) === stamp)!;
    fetched.push(ms);
    return new Promise<Uint8Array>((res) => waiting.push({ ms, resolve: () => res(new Uint8Array([stamps.indexOf(ms)])) }));
  });
  const sample = vi.fn(async (png: Uint8Array) => png[0]!);
  const onUpdate = vi.fn();
  const long = new LongSeries({ fetchFrame, sample, onUpdate, concurrency });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** Resolve everything that's waiting, and whatever that starts, until nothing is left. */
  const drain = async () => {
    await flush();
    while (waiting.length) {
      waiting.shift()!.resolve();
      await flush();
    }
  };
  const ask = (point = NEAR, from = T0, to = T0 + 9 * STEP, centre = T0 + 5 * STEP + 60_000) =>
    long.points("IDR504", GEOM, point, stamps, from, to, centre);
  return { long, fetched, waiting, drain, flush, ask, onUpdate };
}

describe("LongSeries", () => {
  it("keeps `concurrency` fetches in flight, nearest the centre first", () => {
    const { ask, fetched } = setup();
    const r = ask();
    expect(r.pending).toBe(true);
    expect(r.points).toEqual([]);
    expect(fetched).toEqual([stamps[5], stamps[6]]);
  });

  it("returns every sampled point ascending, and is no longer pending, once all have landed", async () => {
    const { ask, drain, fetched, onUpdate } = setup();
    ask();
    await drain();
    expect(fetched).toHaveLength(10);
    expect(onUpdate).toHaveBeenCalledTimes(10);
    const r = ask();
    expect(r.pending).toBe(false);
    expect(r.points).toEqual(stamps.map((ms, i) => [msToStamp(ms), i]));
  });

  it("a narrower range drops queued work outside it", async () => {
    const { ask, drain, fetched } = setup();
    ask(); // starts stamps 5 and 6
    ask(NEAR, T0 + 7 * STEP, T0 + 9 * STEP, T0 + 8 * STEP);
    await drain();
    expect([...new Set(fetched)].sort()).toEqual([5, 6, 7, 8, 9].map((i) => stamps[i]!));
  });

  it("a different point returns nothing at first, then fetches again", async () => {
    const { ask, drain, fetched } = setup();
    ask();
    await drain();
    expect(fetched).toHaveLength(10);
    const r = ask(FAR);
    expect(r.points).toEqual([]);
    expect(r.pending).toBe(true);
    expect(fetched).toHaveLength(12);
  });

  it("cancel drops the queued work, so nothing more is fetched once the frames in flight land", async () => {
    const { ask, drain, fetched, long } = setup();
    ask(); // 2 in flight, 8 queued
    long.cancel();
    await drain();
    expect(fetched).toHaveLength(2);
  });
});
