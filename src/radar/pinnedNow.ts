import { MANIFEST_SPAN_MS } from "../../shared/config";
import { msToStamp, stampToMs } from "../../shared/stamps";
import type { Manifest } from "../../shared/types";
import type { fetchDay, fetchManifest } from "../data/api";

/**
 * Dev only: `?now=YYYYMMDDHHMM` (UTC) pins the app's clock to that instant, so a past storm can be replayed
 * as if it were live. Null when absent or malformed.
 */
export function pinnedNowFromSearch(search: string): number | null {
  const v = new URLSearchParams(search).get("now");
  if (!v) return null;
  try {
    return stampToMs(v);
  } catch {
    return null;
  }
}

/**
 * The API as it would have answered at `nowMs`: no frame after it, and the manifest (which the server builds
 * from its own clock) rebuilt from the archive's day listings to cover the MANIFEST_SPAN_MS before it.
 */
export function pinApiTo<A extends { fetchManifest: typeof fetchManifest; fetchDay: typeof fetchDay }>(
  api: A, nowMs: number,
): A {
  const pinnedDay: typeof fetchDay = async (p, day) =>
    (await api.fetchDay(p, day)).filter((s) => stampToMs(s) <= nowMs);
  const pinnedManifest: typeof fetchManifest = async (p): Promise<Manifest> => {
    const days = [msToStamp(nowMs - 86_400_000).slice(0, 8), msToStamp(nowMs).slice(0, 8)];
    const frames = (await Promise.all(days.map((d) => pinnedDay(p, d)))).flat()
      .filter((s) => stampToMs(s) >= nowMs - MANIFEST_SPAN_MS)
      .sort();
    return { product: p, frames, lastFetchOk: null, lastError: null };
  };
  return { ...api, fetchDay: pinnedDay, fetchManifest: pinnedManifest };
}
