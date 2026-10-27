import { describe, expect, it } from "vitest";
import { parseMapFile } from "../../worker/mapFile";
import { HOME } from "../../shared/config";
import { pickRange } from "./pickRange";
import m501 from "../../shared/__fixtures__/IDR501.map?raw";
import m502 from "../../shared/__fixtures__/IDR502.map?raw";
import m503 from "../../worker/__fixtures__/IDR503.map?raw";
import m504 from "../../shared/__fixtures__/IDR504.map?raw";

const geoms = [m501, m502, m503, m504].map(parseMapFile);

describe("pickRange", () => {
  it("picks the sharpest range for a small view around HOME", () => {
    const d = 0.1;
    expect(
      pickRange(
        { west: HOME.lon - d, east: HOME.lon + d, south: HOME.lat - d, north: HOME.lat + d },
        geoms,
      ),
    ).toBe("IDR504");
  });

  it("picks a wide range for a state-sized view", () => {
    const r = pickRange({ west: 150, east: 155, south: -30, north: -25 }, geoms);
    expect(["IDR501", "IDR502"]).toContain(r);
  });

  it("returns the widest when the view exceeds every frame", () => {
    expect(pickRange({ west: 140, east: 160, south: -40, north: -15 }, geoms)).toBe("IDR501");
  });
});
