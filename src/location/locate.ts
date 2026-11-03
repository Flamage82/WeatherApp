import type { LatLon } from "../../shared/types";

/** One fix, never a watch: the pin stays where it is until the user asks again. */
const OPTIONS: PositionOptions = { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 };

/** The device's position once. Rejects with no Geolocation, a denied permission, an error or a timeout. */
export function locateOnce(geo: Geolocation | undefined = globalThis.navigator?.geolocation): Promise<LatLon> {
  return new Promise((resolve, reject) => {
    if (!geo) return reject(new Error("geolocation unavailable"));
    geo.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(err.message || "geolocation failed")),
      OPTIONS,
    );
  });
}
