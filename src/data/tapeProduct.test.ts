import { describe, expect, it } from "vitest";
import type { ProductId } from "../../shared/config";
import { uvToLonLat } from "../../shared/gnomonic";
import type { RadarGeometry } from "../../shared/types";
import { parseMapFile } from "../../worker/mapFile";
import m501 from "../../shared/__fixtures__/IDR501.map?raw";
import m502 from "../../shared/__fixtures__/IDR502.map?raw";
import m504 from "../../shared/__fixtures__/IDR504.map?raw";
import m661 from "../../shared/__fixtures__/IDR661.map?raw";
import m662 from "../../shared/__fixtures__/IDR662.map?raw";
import m663 from "../../shared/__fixtures__/IDR663.map?raw";
import m664 from "../../shared/__fixtures__/IDR664.map?raw";
import m503 from "../../worker/__fixtures__/IDR503.map?raw";
import { BRISBANE } from "../location/location";
import { chooseTapeProduct } from "./tapeProduct";

const CALVERT = { lat: -27.67217111736596, lon: 152.49661614726207 };

const geoms = Object.fromEntries(
  Object.entries({
    IDR501: m501, IDR502: m502, IDR503: m503, IDR504: m504,
    IDR661: m661, IDR662: m662, IDR663: m663, IDR664: m664,
  }).map(([id, text]) => [id, parseMapFile(text)]),
) as Record<ProductId, RadarGeometry>;
const loaded = (id: ProductId) => geoms[id];

describe("chooseTapeProduct", () => {
  it("picks the finest range whose frame holds the 1 km disc", () => {
    expect(chooseTapeProduct("marburg", CALVERT, loaded)).toBe("IDR504");
    expect(chooseTapeProduct("stapylton", BRISBANE, loaded)).toBe("IDR664");
    expect(chooseTapeProduct("stapylton", CALVERT, loaded)).toBe("IDR663");
  });

  it("steps up a range when the disc would cross the 64 km frame's edge", () => {
    const nearEdge = uvToLonLat(geoms.IDR504, 0.3 / 128, 0.5); // 0.3 km inside the west edge
    expect(chooseTapeProduct("marburg", { lat: nearEdge.lat, lon: nearEdge.lon }, loaded)).toBe("IDR503");
  });

  it("falls back to the widest range while no geometry has loaded", () => {
    expect(chooseTapeProduct("marburg", CALVERT, () => null)).toBe("IDR501");
  });
});
