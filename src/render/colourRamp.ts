/**
 * Radar colour ramp (spec §7.2, scheme A "refined classic").
 *
 * Continuous over BOM levels 0..15: RGB is interpolated linearly in sRGB between stops, as is alpha.
 * Below the first stop (level 1) the first stop's colour fades linearly to fully transparent at 0,
 * so light rain thins out towards nothing. At and above level 15 the last stop holds.
 */
export const RAMP_STOPS: { level: number; rgb: string; alpha: number }[] = [
  { level: 1, rgb: "#81d4fa", alpha: 0.35 },
  { level: 3, rgb: "#29b6f6", alpha: 0.75 },
  { level: 5, rgb: "#43a047", alpha: 1 },
  { level: 8, rgb: "#fdd835", alpha: 1 },
  { level: 10, rgb: "#fb8c00", alpha: 1 },
  { level: 12, rgb: "#e53935", alpha: 1 },
  { level: 15, rgb: "#d81b9a", alpha: 1 },
];

export const MAX_LEVEL = 15;
export const LUT_SIZE = 256;

type Stop = { level: number; r: number; g: number; b: number; a: number };

const STOPS: Stop[] = RAMP_STOPS.map((s) => ({
  level: s.level,
  r: parseInt(s.rgb.slice(1, 3), 16),
  g: parseInt(s.rgb.slice(3, 5), 16),
  b: parseInt(s.rgb.slice(5, 7), 16),
  a: s.alpha * 255,
}));
// Implicit level-0 stop: the first colour, fully transparent.
const ALL: Stop[] = [{ ...STOPS[0]!, level: 0, a: 0 }, ...STOPS];

/** RGBA bytes (0..255) for a (possibly fractional) level. Same values as `buildRampLUT`'s entries. */
export function rampColour(level: number): [number, number, number, number] {
  const l = Math.min(MAX_LEVEL, Math.max(0, level));
  let k = 1;
  while (k < ALL.length - 1 && ALL[k]!.level < l) k++;
  const lo = ALL[k - 1]!;
  const hi = ALL[k]!;
  const t = (l - lo.level) / (hi.level - lo.level);
  const mix = (p: number, q: number) => Math.round(p + (q - p) * t);
  return [mix(lo.r, hi.r), mix(lo.g, hi.g), mix(lo.b, hi.b), mix(lo.a, hi.a)];
}

/**
 * 256 x RGBA lookup table; entry i is the colour of level i/255*15, so a level maps to
 * index round(level/15*255). Every stop lands exactly on an entry (255/15 = 17), so linear
 * texture filtering of this table reproduces `rampColour` between entries too.
 */
export function buildRampLUT(): Uint8Array {
  const lut = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) lut.set(rampColour((i / (LUT_SIZE - 1)) * MAX_LEVEL), i * 4);
  return lut;
}
