import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW_MS, MAX_FLOW_GAP_MS } from "../../shared/config";
import { isFlowGap, loopWindow, locate, stepPlayback, SPEED_SCALE, type PlayState } from "./timeline";

const F = [0, 300_000, 600_000, 2_400_000]; // last gap is 30 min
const WIN = { start: 0, end: 7.2e6 };
const HOLD_MS = 1000;

function play(over: Partial<PlayState>): PlayState {
  return { t: 0, speed: 1, lastSpeed: 1, holdMs: 0, ...over };
}

/** Step `n` times with `dt` ms each, returning the final state. */
function run(s: PlayState, n: number, dt: number, win = WIN): PlayState {
  let cur = s;
  for (let k = 0; k < n; k++) cur = stepPlayback(cur, dt, win);
  return cur;
}

describe("locate", () => {
  it("interpolates between frames", () => {
    expect(locate(F, 450_000)).toEqual({ i: 1, alpha: 0.5, gapMs: 300_000 });
  });
  it("clamps before the first frame", () => {
    expect(locate(F, -5)).toEqual({ i: 0, alpha: 0, gapMs: 300_000 });
  });
  it("clamps after the last frame", () => {
    expect(locate(F, 9e9).alpha).toBe(1);
  });
  it("reports the gap of the bracketing pair", () => {
    expect(locate(F, 1_500_000)).toMatchObject({ i: 2, gapMs: 1_800_000 });
  });
  it("handles a single frame without a gap", () => {
    expect(locate([5], 10)).toEqual({ i: 0, alpha: 0, gapMs: 0 });
  });
  it("returns alpha 0 for duplicate frames", () => {
    expect(locate([0, 0, 100], 0).alpha).toBe(0);
  });
});

describe("isFlowGap", () => {
  it("flags gaps longer than MAX_FLOW_GAP_MS", () => {
    expect(isFlowGap(MAX_FLOW_GAP_MS)).toBe(false);
    expect(isFlowGap(MAX_FLOW_GAP_MS + 1)).toBe(true);
    expect(locate(F, 1_500_000).gapMs).toBeGreaterThan(MAX_FLOW_GAP_MS);
  });
});

describe("stepPlayback", () => {
  it("advances 1x for 100 ms by 60 000 radar-ms", () => {
    expect(stepPlayback(play({}), 100, WIN).t).toBe(60_000);
  });
  it("clamps dt to 100 ms", () => {
    expect(stepPlayback(play({}), 60_000, WIN).t).toBe(60_000);
  });
  it("scales by speed and SPEED_SCALE", () => {
    expect(SPEED_SCALE).toBe(600);
    expect(stepPlayback(play({ speed: 2 }), 100, WIN).t).toBe(120_000);
    expect(stepPlayback(play({ t: 60_000, speed: -0.5 }), 100, WIN).t).toBe(30_000);
  });
  it("moves backwards for negative speed", () => {
    expect(stepPlayback(play({ t: 60_000, speed: -1 }), 100, WIN).t).toBe(0);
  });
  it("keeps speed and lastSpeed when stepping", () => {
    const next = stepPlayback(play({ speed: -2, lastSpeed: 3 }), 100, WIN);
    expect(next.speed).toBe(-2);
    expect(next.lastSpeed).toBe(3);
  });

  it("paused (speed 0) returns the state unchanged", () => {
    const s = play({ t: 1234, speed: 0, lastSpeed: 2, holdMs: 500 });
    expect(stepPlayback(s, 100, WIN)).toEqual(s);
    expect(stepPlayback(s, 100, WIN).t).toBe(1234);
    expect(stepPlayback(s, 100, WIN).holdMs).toBe(500);
  });

  it("forward: clamps to end on arrival and starts holding", () => {
    const next = stepPlayback(play({ t: WIN.end - 60_000 }), 100, WIN);
    expect(next.t).toBe(WIN.end);
    expect(next.holdMs).toBe(100);
  });
  it("forward: holds at end for 1000 ms, then wraps to start", () => {
    const arrived = stepPlayback(play({ t: WIN.end - 60_000 }), 100, WIN);
    const held = run(arrived, 8, 100); // 900 ms of hold
    expect(held.t).toBe(WIN.end);
    expect(held.holdMs).toBe(900);
    const wrapped = stepPlayback(held, 100, WIN); // 1000 ms reached
    expect(wrapped.t).toBe(WIN.start);
    expect(wrapped.holdMs).toBe(0);
  });
  it("forward: a point already past the end clamps and holds", () => {
    const next = stepPlayback(play({ t: WIN.end + 1e6 }), 100, WIN);
    expect(next.t).toBe(WIN.end);
    expect(next.holdMs).toBe(100);
  });

  it("reverse: clamps to start on arrival and starts holding", () => {
    const next = stepPlayback(play({ t: WIN.start + 60_000, speed: -1 }), 100, WIN);
    expect(next.t).toBe(WIN.start);
    expect(next.holdMs).toBe(100);
  });
  it("reverse: holds at start for 1000 ms, then wraps to end", () => {
    const arrived = stepPlayback(play({ t: WIN.start + 60_000, speed: -1 }), 100, WIN);
    const held = run(arrived, 8, 100, WIN);
    expect(held.t).toBe(WIN.start);
    expect(held.holdMs).toBe(900);
    const wrapped = stepPlayback(held, 100, WIN);
    expect(wrapped.t).toBe(WIN.end);
    expect(wrapped.holdMs).toBe(0);
  });

  it("a full forward loop holds for exactly HOLD_MS", () => {
    // Arrival step plus 9 more = 1000 ms of hold; the 10th step wraps.
    const s = run(play({ t: WIN.end - 60_000 }), 10, 100);
    expect(s.t).toBe(WIN.start);
    expect(s.holdMs).toBe(0);
    expect(HOLD_MS).toBe(1000);
  });

  it("reversing direction while holding at end cancels the hold", () => {
    const holding = play({ t: WIN.end, speed: 1, holdMs: 500 });
    const next = stepPlayback({ ...holding, speed: -1 }, 100, WIN);
    expect(next.t).toBe(WIN.end - 60_000);
    expect(next.holdMs).toBe(0);
  });

  it("clamps a t outside the window into it before stepping", () => {
    expect(stepPlayback(play({ t: -5e6 }), 100, WIN).t).toBe(60_000);
    expect(stepPlayback(play({ t: 9e9, speed: -1 }), 100, WIN).t).toBe(WIN.end - 60_000);
  });
});

describe("loopWindow", () => {
  const H = 3_600_000;
  const N = 100 * H;
  it("at now gives the last 2 h", () => {
    expect(loopWindow(N, N)).toEqual({ start: N - 2 * H, end: N });
  });
  it("near now still gives the last 2 h", () => {
    expect(loopWindow(N - 0.5 * H, N)).toEqual({ start: N - 2 * H, end: N });
  });
  it("scrolled back is centred on t", () => {
    expect(loopWindow(N - 30 * H, N)).toEqual({ start: N - 31 * H, end: N - 29 * H });
  });
  it("defaults the span to DEFAULT_WINDOW_MS", () => {
    const w = loopWindow(N - 30 * H, N);
    expect(w.end - w.start).toBe(DEFAULT_WINDOW_MS);
  });
  it("honours an explicit span", () => {
    expect(loopWindow(N - 30 * H, N, H)).toEqual({ start: N - 30.5 * H, end: N - 29.5 * H });
  });
});
