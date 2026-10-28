import { describe, expect, it } from "vitest";
import { MAX_FLOW_GAP_MS, NOWCAST_MAX_MS } from "../../shared/config";
import { isFlowGap, locate, stepPlayback, SPEED_SCALE, type PlayState } from "./timeline";

const F = [0, 300_000, 600_000, 2_400_000]; // last gap is 30 min
const NOW = 7.2e6;
const WIN = { start: 0, end: NOW + NOWCAST_MAX_MS, now: NOW };

function play(over: Partial<PlayState>): PlayState {
  return { t: 0, speed: 1, lastSpeed: 1, ...over };
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
  it("paused (speed 0) returns the state unchanged", () => {
    const s = play({ t: 1234, speed: 0, lastSpeed: 2 });
    expect(stepPlayback(s, 100, WIN)).toBe(s);
  });

  it("crossing now stops exactly at now, from either side, unless manual", () => {
    expect(stepPlayback(play({ t: NOW - 30_000 }), 100, WIN)).toEqual({ t: NOW, speed: 0, lastSpeed: 1 });
    expect(stepPlayback(play({ t: NOW + 30_000, speed: -1, lastSpeed: -1 }), 100, WIN))
      .toEqual({ t: NOW, speed: 0, lastSpeed: -1 });
    expect(stepPlayback(play({ t: NOW - 30_000 }), 100, WIN, true)).toMatchObject({ t: NOW + 30_000, speed: 1 });
  });
  it("starting at now plays on into the nowcast", () => {
    expect(stepPlayback(play({ t: NOW }), 100, WIN)).toMatchObject({ t: NOW + 60_000, speed: 1 });
  });
  it("stops at the nowcast end and at the start, keeping lastSpeed; no loop", () => {
    const end = run(play({ t: NOW, speed: 4, lastSpeed: 4 }), 100, 100);
    expect(end).toEqual({ t: WIN.end, speed: 0, lastSpeed: 4 });
    expect(stepPlayback(end, 100, WIN)).toBe(end);
    const start = run(play({ t: 3e5, speed: -1, lastSpeed: -1 }), 10, 100);
    expect(start).toEqual({ t: WIN.start, speed: 0, lastSpeed: -1 });
  });
});
