import { describe, expect, it, vi } from "vitest";
import { BRISBANE } from "./location";
import { searchPlaces } from "./geocode";

const feature = (name: string, lon: number, lat: number, props: object = {}) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { name, ...props },
});

describe("searchPlaces", () => {
  it("keeps places inside radar coverage, with lat and lon the right way round", async () => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({
        type: "FeatureCollection",
        features: [
          feature("Lowood", 152.58, -27.46, { city: "Lowood", county: "Somerset Region", state: "Queensland" }),
          feature("Sydney", 151.21, -33.87, { state: "New South Wales" }),
        ],
      })));
    const places = await searchPlaces("Low", BRISBANE, new AbortController().signal, f as typeof fetch);
    expect(places).toEqual([
      { name: "Lowood", lat: -27.46, lon: 152.58, detail: "Somerset Region, Queensland" },
    ]);
    const url = String(f.mock.calls[0]![0]);
    expect(url).toContain("bbox=147.3,-32.4,158.5,-22.9");
    expect(url).toContain("limit=6");
    expect(url).toContain("q=Low");
  });

  it("makes no request for a query under 2 characters", async () => {
    const f = vi.fn();
    expect(await searchPlaces(" a ", BRISBANE, new AbortController().signal, f as unknown as typeof fetch)).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});
