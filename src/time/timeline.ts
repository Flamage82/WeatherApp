import { MAX_FLOW_GAP_MS } from "../../shared/config";

/** Radar-ms advanced per real-ms at 1x speed (10 min of radar time per 1 s). */
export const SPEED_SCALE = 600;

/** Largest real-time step accepted by stepPlayback, so a stalled tab cannot jump. */
const MAX_DT_MS = 100;

export type PlayState = {
  t: number;
  /** −4..4; 0 = paused. */
  speed: number;
  /** Last non-zero speed, so resuming from pause can restore it. */
  lastSpeed: number;
};

/**
 * Locates `t` between ascending frame times. `t` is clamped to the frame range.
 * `i` is the index of the earlier frame, `alpha` is the blend fraction in [0, 1],
 * and `gapMs` is the spacing of that frame pair (0 when there is only one frame).
 */
export function locate(
  frames: number[],
  t: number,
): { i: number; alpha: number; gapMs: number } {
  const n = frames.length;
  if (n === 0) throw new Error("locate: no frames");
  if (n === 1) return { i: 0, alpha: 0, gapMs: 0 };

  const x = Math.min(Math.max(t, frames[0]!), frames[n - 1]!);

  // Largest index i in [0, n - 2] with frames[i] <= x.
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }

  const a = frames[lo]!;
  const gapMs = frames[lo + 1]! - a;
  const alpha = gapMs > 0 ? (x - a) / gapMs : 0;
  return { i: lo, alpha, gapMs };
}

/** True when a gap between frames is too long to draw as continuous flow. */
export const isFlowGap = (gapMs: number): boolean => gapMs > MAX_FLOW_GAP_MS;

/**
 * Advances playback by `dtMs` of real time. `bounds`: `start`..`end` is where the playhead may go
 * (the loaded start to the end of the nowcast) and `now` is the newest frame.
 *
 * - speed 0 returns the state unchanged.
 * - A `t` outside the bounds is clamped into them first.
 * - Reaching `start` or `end` in the direction of travel stops there (speed 0, lastSpeed kept). No loop.
 * - Crossing `now` (from either side) stops exactly at `now`, unless `manual` (the user is dragging
 *   the tape or holding the lever). Starting at `now` is not a crossing, so Play at `now` runs on.
 */
export function stepPlayback(
  s: PlayState,
  dtMs: number,
  bounds: { start: number; end: number; now: number },
  manual = false,
): PlayState {
  if (s.speed === 0) return s;

  const dt = Math.min(dtMs, MAX_DT_MS);
  const dir = Math.sign(s.speed);
  const t = Math.min(Math.max(s.t, bounds.start), bounds.end);
  const next = t + dir * dt * SPEED_SCALE * Math.abs(s.speed);
  const stop = (at: number): PlayState => ({ ...s, t: at, speed: 0 });

  if (!manual && (dir > 0 ? t < bounds.now && next >= bounds.now : t > bounds.now && next <= bounds.now)) {
    return stop(bounds.now);
  }
  if (dir > 0 ? next >= bounds.end : next <= bounds.start) return stop(dir > 0 ? bounds.end : bounds.start);
  return { ...s, t: next };
}
