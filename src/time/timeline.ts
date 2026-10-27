import { DEFAULT_WINDOW_MS, MAX_FLOW_GAP_MS } from "../../shared/config";

/** Radar-ms advanced per real-ms at 1x speed (10 min of radar time per 1 s). */
export const SPEED_SCALE = 600;

/** Largest real-time step accepted by stepPlayback, so a stalled tab cannot jump. */
const MAX_DT_MS = 100;

/** How long playback rests on a window edge before wrapping to the other edge. */
const HOLD_MS = 1000;

export type PlayState = {
  t: number;
  /** −4..4; 0 = paused. */
  speed: number;
  /** Last non-zero speed, so resuming from pause can restore it. */
  lastSpeed: number;
  /** Time spent resting on the window edge in the direction of travel. */
  holdMs: number;
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
 * Advances playback by `dtMs` of real time within `win`.
 *
 * - speed 0 returns the state unchanged.
 * - A `t` outside the window is clamped into it first.
 * - Reaching an edge in the direction of travel clamps `t` to that edge and starts
 *   `holdMs`. After HOLD_MS of hold, `t` wraps to the opposite edge and `holdMs` resets.
 * - Reversing direction while holding cancels the hold.
 */
export function stepPlayback(
  s: PlayState,
  dtMs: number,
  win: { start: number; end: number },
): PlayState {
  if (s.speed === 0) return s;

  const dt = Math.min(dtMs, MAX_DT_MS);
  const dir = Math.sign(s.speed);
  const edge = dir > 0 ? win.end : win.start;
  const t = Math.min(Math.max(s.t, win.start), win.end);

  if (t === edge) {
    const holdMs = s.holdMs + dt;
    if (holdMs >= HOLD_MS) {
      return { ...s, t: dir > 0 ? win.start : win.end, holdMs: 0 };
    }
    return { ...s, t, holdMs };
  }

  const next = t + dir * dt * SPEED_SCALE * Math.abs(s.speed);
  const reached = dir > 0 ? next >= win.end : next <= win.start;
  if (reached) return { ...s, t: edge, holdMs: dt };
  return { ...s, t: next, holdMs: 0 };
}

/**
 * A window of length `spanMs` centred on `t`, shifted back so that `end <= newestMs`.
 */
export function loopWindow(
  t: number,
  newestMs: number,
  spanMs = DEFAULT_WINDOW_MS,
): { start: number; end: number } {
  let start = t - spanMs / 2;
  let end = start + spanMs;
  const excess = end - newestMs;
  if (excess > 0) {
    start -= excess;
    end -= excess;
  }
  return { start, end };
}
