/** Lever range: −4× at the bottom to +4× at the top (spec §6.3). */
export const MAX_SPEED = 4;
/** Light detents; a speed within DETENT_SNAP of one snaps to it. Also the `[` / `]` steps. */
export const DETENTS = [-4, -2, -1, 0, 1, 2, 4];
/** How strongly the lever bends toward fine control near the middle: bigger is finer there, and steeper at the ends. */
const CURVE = 3;
/** A lever position within this of a detent snaps to it (the lever's half-length is 1), so about 10 px on a tall lever. */
const DETENT_SNAP = 0.05;

/** Lever offset from the middle, −1 (bottom) … 1 (top), for a speed: the inverse of the exponential curve. */
function speedToOffset(speed: number): number {
  return (Math.sign(speed) * Math.log1p((Math.abs(speed) / MAX_SPEED) * Math.expm1(CURVE))) / CURVE;
}

/**
 * Speed for a lever position (0 bottom … 1 top): exponential in the distance from the middle, from 0 at the
 * middle to ±4 at the ends, so slow scrubbing gets most of the lever. Snaps to a detent near its position.
 */
export function leverToSpeed(pos: number): number {
  const u = (Math.min(1, Math.max(0, pos)) - 0.5) * 2;
  return (
    DETENTS.find((d) => Math.abs(u - speedToOffset(d)) <= DETENT_SNAP) ??
    (Math.sign(u) * MAX_SPEED * Math.expm1(CURVE * Math.abs(u))) / Math.expm1(CURVE)
  );
}

export function speedToLever(speed: number): number {
  return Math.min(1, Math.max(0, speedToOffset(speed) / 2 + 0.5));
}

/** The next detent above (dir > 0) or below `speed`, held at the ends. */
export function stepDetent(speed: number, dir: number): number {
  if (dir > 0) return DETENTS.find((d) => d > speed + 1e-9) ?? MAX_SPEED;
  return DETENTS.findLast((d) => d < speed - 1e-9) ?? -MAX_SPEED;
}
