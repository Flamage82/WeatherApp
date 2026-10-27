import { describe, expect, it } from "vitest";
import { parseMapFile } from "./mapFile";
import fixture from "./__fixtures__/IDR503.map?raw";

describe("parseMapFile", () => {
  const g = parseMapFile(fixture);

  it("reads the product from the first line", () => {
    expect(g.product).toBe("IDR503");
  });

  it("reads the name from the second line", () => {
    expect(g.name).toBe("Marburg (128 km)");
  });

  it("reads the centre", () => {
    expect(g.centre).toEqual({ lat: -27.608, lon: 152.539 });
  });

  it("maps lon0/lat0 to bl, lon1/lat1 to tl, lon2/lat2 to tr, lon3/lat3 to br", () => {
    expect(g.corners.bl).toEqual({ lon: 151.23309, lat: -28.74816 });
    expect(g.corners.tl).toEqual({ lon: 151.26024, lat: -26.44776 });
    expect(g.corners.tr).toEqual({ lon: 153.8297, lat: -26.44766 });
    expect(g.corners.br).toEqual({ lon: 153.85709, lat: -28.74804 });
  });

  it("accepts arbitrary spacing around '=' and CRLF line endings", () => {
    const crlf = fixture.replace(/\n/g, "\r\n");
    expect(parseMapFile(crlf)).toEqual(g);
  });

  it("throws when projection is not Gnomonic", () => {
    const bad = fixture.replace("projection = Gnomonic", "projection = Mercator");
    expect(() => parseMapFile(bad)).toThrow(/Gnomonic/);
  });

  it("throws when a required key is missing", () => {
    const missing = fixture.replace(/^lat2 .*$/m, "");
    expect(() => parseMapFile(missing)).toThrow(/lat2/);
  });
});
