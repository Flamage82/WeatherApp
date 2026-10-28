/** Lever range: −4× at the bottom to +4× at the top (spec §6.3). */
export const MAX_SPEED = 4;
/** Light detents; a speed within DETENT_SNAP of one snaps to it. Also the `[` / `]` steps. */
export const DETENTS = [-4, -2, -1, 0, 1, 2, 4];
const DETENT_SNAP = 0.15;

/** Speed for a lever position (0 bottom … 1 top): linear −4..4, snapped to the nearest detent within ±0.15. */
export function leverToSpeed(pos: number): number {
  const s = (Math.min(1, Math.max(0, pos)) - 0.5) * 2 * MAX_SPEED;
  return DETENTS.find((d) => Math.abs(s - d) <= DETENT_SNAP) ?? s;
}

export function speedToLever(speed: number): number {
  return Math.min(1, Math.max(0, speed / (2 * MAX_SPEED) + 0.5));
}

/** The next detent above (dir > 0) or below `speed`, held at the ends. */
export function stepDetent(speed: number, dir: number): number {
  if (dir > 0) return DETENTS.find((d) => d > speed + 1e-9) ?? MAX_SPEED;
  return DETENTS.findLast((d) => d < speed - 1e-9) ?? -MAX_SPEED;
}
