import { stampToMs } from "../../shared/stamps";
import type { Manifest } from "../../shared/types";

/** Primary (Marburg) newest frame older than this → switch the whole loop to Mt Stapylton (spec §7.6). */
export const STALE_SWITCH_MS = 1_200_000;
/** Newest frame older than this → the status bar shows a warning (spec §6.1, Task 13). */
export const STALE_WARN_MS = 900_000;

export type RadarName = "marburg" | "stapylton";
export type RadarChoice = { radar: RadarName; status: "ok" | "stale" | "empty"; newestMs: number | null };

function newestOf(m: Manifest | null): number | null {
  const s = m?.frames.at(-1);
  return s ? stampToMs(s) : null;
}

/**
 * Picks the radar for the whole loop from each radar's tape-product manifest. Staleness is judged
 * from the newest frame's age only (manifests are written only when frames arrive, so
 * `lastFetchOk` says nothing about freshness).
 *
 * - Marburg fresh (newest ≤ STALE_SWITCH_MS old) → marburg/ok.
 * - Otherwise (stale, missing or empty) Stapylton fresh → stapylton/ok.
 * - Neither has any frame → marburg/empty, newestMs null.
 * - Both stale → whichever has the newer frame, "stale"; ties go to Marburg.
 */
export function chooseRadar(
  m: { marburg: Manifest | null; stapylton: Manifest | null },
  nowMs: number,
): RadarChoice {
  const mb = newestOf(m.marburg);
  const st = newestOf(m.stapylton);
  const fresh = (x: number | null): x is number => x !== null && nowMs - x <= STALE_SWITCH_MS;
  if (fresh(mb)) return { radar: "marburg", status: "ok", newestMs: mb };
  if (fresh(st)) return { radar: "stapylton", status: "ok", newestMs: st };
  if (mb === null && st === null) return { radar: "marburg", status: "empty", newestMs: null };
  if (st !== null && (mb === null || st > mb)) return { radar: "stapylton", status: "stale", newestMs: st };
  return { radar: "marburg", status: "stale", newestMs: mb };
}
