import type { LatLon } from "../../shared/types";
import { inCoverage } from "./location";

export type Place = LatLon & { name: string; detail: string };

const PHOTON = "https://photon.komoot.io/api/";
/** The coverage box (west, south, east, north) that covers both radars' 512 km frames. */
const BBOX = "147.3,-32.4,158.5,-22.9";
const MIN_QUERY = 2;

type Feature = {
  geometry?: { coordinates?: [number, number] };
  properties?: { name?: string; city?: string; county?: string; state?: string };
};

/**
 * Photon (OpenStreetMap) suggestions for `q`, biased toward `near`, inside the coverage box and dropping
 * anything outside radar coverage. A query under 2 characters makes no request.
 */
export async function searchPlaces(
  q: string, near: LatLon, signal: AbortSignal, f: typeof fetch = fetch,
): Promise<Place[]> {
  const query = q.trim();
  if (query.length < MIN_QUERY) return [];
  const url = `${PHOTON}?q=${encodeURIComponent(query)}&lat=${near.lat}&lon=${near.lon}&limit=6&lang=en&bbox=${BBOX}`;
  const res = await f(url, { signal });
  if (!res.ok) throw new Error(`geocoder failed: ${res.status}`);
  const { features = [] } = (await res.json()) as { features?: Feature[] };
  return features.flatMap((ft): Place[] => {
    const [lon, lat] = ft.geometry?.coordinates ?? [];
    const props = ft.properties;
    if (lon === undefined || lat === undefined || !props?.name || !inCoverage({ lat, lon })) return [];
    const detail = [props.city, props.county, props.state]
      .filter((part): part is string => !!part && part !== props.name)
      .slice(0, 2)
      .join(", ");
    return [{ name: props.name, lat, lon, detail }];
  });
}
