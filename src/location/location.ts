import { RADARS } from "../../shared/config";
import type { LatLon } from "../../shared/types";
import type { RadarName } from "../data/chooseRadar";

export type SavedLocation = LatLon & { name?: string; radarOverride: RadarName | null };

export const BRISBANE: LatLon = { lat: -27.4698, lon: 153.0251 };
export const LOCATION_KEY = "rain-radar.location";

/** A frame reaches 512 km each way from its radar; 500 km east-west and north-south of a centre is a slightly conservative fit. */
const COVERAGE_KM = 500;

/** Equirectangular offset of `p` from `from`, in km: [east, north]. */
function offsetKm(from: LatLon, p: LatLon): [number, number] {
  return [(p.lon - from.lon) * 111.32 * Math.cos((from.lat * Math.PI) / 180), (p.lat - from.lat) * 110.57];
}

const RADAR_NAMES = Object.keys(RADARS) as RadarName[];

export function nearestRadar(p: LatLon): RadarName {
  const dist = (r: RadarName) => Math.hypot(...offsetKm(RADARS[r].centre, p));
  return RADAR_NAMES.reduce((best, r) => (dist(r) < dist(best) ? r : best));
}

export function inCoverage(p: LatLon): boolean {
  return RADAR_NAMES.some((r) => {
    const [east, north] = offsetKm(RADARS[r].centre, p);
    return Math.abs(east) <= COVERAGE_KM && Math.abs(north) <= COVERAGE_KM;
  });
}

/** The saved location, or null when it's missing, corrupt, old-shaped or out of coverage. */
export function loadLocation(s: Pick<Storage, "getItem">): SavedLocation | null {
  try {
    const raw: unknown = JSON.parse(s.getItem(LOCATION_KEY) ?? "null");
    if (typeof raw !== "object" || raw === null) return null;
    const { lat, lon, name, radarOverride } = raw as Record<string, unknown>;
    if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (radarOverride !== null && radarOverride !== "marburg" && radarOverride !== "stapylton") return null;
    if (!inCoverage({ lat, lon })) return null;
    return { lat, lon, ...(typeof name === "string" ? { name } : {}), radarOverride };
  } catch {
    return null;
  }
}

/** Saves Brisbane if nothing is saved yet, so a later open restores it rather than asking for a fix again. */
export function rememberDefault(s: Pick<Storage, "getItem" | "setItem">): void {
  if (loadLocation(s) === null) saveLocation(s, { ...BRISBANE, radarOverride: null });
}

export function saveLocation(s: Pick<Storage, "setItem">, l: SavedLocation): void {
  try {
    s.setItem(LOCATION_KEY, JSON.stringify(l));
  } catch {
    // Storage is full or disabled: the location just isn't remembered.
  }
}
