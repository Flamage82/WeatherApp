import { stampToMs } from "../../shared/stamps";
import type { Manifest } from "../../shared/types";

/** Primary (Marburg) newest frame older than this → switch the whole loop to Mt Stapylton (spec §7.6). */
export const STALE_SWITCH_MS = 1_200_000;
/** Newest frame older than this → the status bar shows a warning (spec §6.1, Task 13). */
export const STALE_WARN_MS = 900_000;

export type RadarName = "marburg" | "stapylton";
export type RadarChoice = {
  radar: RadarName;
  status: "ok" | "stale" | "empty";
  newestMs: number | null;
  /** True when `radar` isn't the preferred one (the preferred one was stale and the other fresh). */
  fallback: boolean;
};

function newestOf(m: Manifest | null): number | null {
  const s = m?.frames.at(-1);
  return s ? stampToMs(s) : null;
}

/**
 * Picks the radar for the whole loop from each radar's check-product manifest. Staleness is judged
 * from the newest frame's age only (manifests are written only when frames arrive, so
 * `lastFetchOk` says nothing about freshness). `pref.radar` is the nearer radar, or the user's choice
 * when `pref.manual`.
 *
 * - Preferred fresh (newest ≤ STALE_SWITCH_MS old) → it, ok.
 * - Manual and not fresh → still the preferred, "stale" (or "empty" with no frames). Never the other.
 * - Automatic and not fresh: the other radar if it's fresh (ok, `fallback`).
 * - Neither has any frame → the preferred, empty, newestMs null.
 * - Both stale → whichever has the newer frame, "stale"; ties go to the preferred.
 */
export function chooseRadar(
  m: { marburg: Manifest | null; stapylton: Manifest | null },
  nowMs: number,
  pref: { radar: RadarName; manual: boolean },
): RadarChoice {
  const other: RadarName = pref.radar === "marburg" ? "stapylton" : "marburg";
  const p = newestOf(m[pref.radar]);
  const o = newestOf(m[other]);
  const fresh = (x: number | null): x is number => x !== null && nowMs - x <= STALE_SWITCH_MS;
  if (fresh(p)) return { radar: pref.radar, status: "ok", newestMs: p, fallback: false };
  const stay: RadarChoice = { radar: pref.radar, status: p === null ? "empty" : "stale", newestMs: p, fallback: false };
  if (pref.manual) return stay;
  if (fresh(o)) return { radar: other, status: "ok", newestMs: o, fallback: true };
  if (o !== null && (p === null || o > p)) return { radar: other, status: "stale", newestMs: o, fallback: true };
  return stay;
}
