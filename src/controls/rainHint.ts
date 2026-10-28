/** Intensity word for a level, by the legend's bands: light (0.2–1.5 mm/h), moderate (to 10), heavy (to 50), severe. */
export function intensityWord(level: number): string {
  if (level < 3.5) return "light";
  if (level < 7.5) return "moderate";
  if (level < 11.5) return "heavy";
  return "severe";
}

/** Minutes rounded to 5, at least 5. */
const mins5 = (ms: number) => Math.max(5, Math.round(ms / 300_000) * 5);

/**
 * The "rain at home" line under the clock, from the nowcast at home: `levels[k]` is the level at
 * newest + k * stepMs (k = 0 is the newest frame), NaN where unknown.
 *  - raining at the newest frame: "Raining now · moderate", plus " · until ~20 min" if it stops;
 *  - else the first rain: "Rain in ~25 min · heavy" (the word from the peak from then on);
 *  - else null.
 */
export function rainHint(levels: ArrayLike<number>, stepMs: number): string | null {
  const n = levels.length;
  // Half a level: ignores the faint bilinear fringe at a storm's edge.
  const wet = (k: number) => levels[k]! >= 0.5;
  if (n === 0 || Number.isNaN(levels[0])) return null;
  if (wet(0)) {
    let k = 1;
    while (k < n && wet(k)) k++;
    const until = k < n && !Number.isNaN(levels[k]) ? ` · until ~${mins5(k * stepMs)} min` : "";
    return `Raining now · ${intensityWord(levels[0]!)}${until}`;
  }
  let k = 1;
  while (k < n && !wet(k)) k++;
  if (k >= n) return null;
  let peak = 0;
  for (let j = k; j < n; j++) if (levels[j]! > peak) peak = levels[j]!;
  return `Rain in ~${mins5(k * stepMs)} min · ${intensityWord(peak)}`;
}
