import { describe, expect, it } from "vitest";
import { parseMapFile } from "../../worker/mapFile";
import { HOME } from "../../shared/config";
import { lonLatToUV, uvToLonLat } from "../../shared/gnomonic";
import m503 from "../../worker/__fixtures__/IDR503.map?raw";
import m501 from "../../shared/__fixtures__/IDR501.map?raw";
import {
  gnomonicUniforms, lonLatToMerc, mercQuad, mercToLonLat, mercToUV, unionQuad, uvToPixel,
} from "./geometryUniforms";

const g503 = parseMapFile(m503);
const g501 = parseMapFile(m501);

describe("shader projection mirror", () => {
  it("lonLatToMerc / mercToLonLat round-trip", () => {
    const m = lonLatToMerc(HOME.lon, HOME.lat);
    const p = mercToLonLat(m.x, m.y);
    expect(p.lon).toBeCloseTo(HOME.lon, 9);
    expect(p.lat).toBeCloseTo(HOME.lat, 9);
  });

  it("Mercator -> uv agrees with shared lonLatToUV across the frame", () => {
    const gu = gnomonicUniforms(g503);
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5], [0.13, 0.77], [0.9, 0.2]] as const) {
      const ll = uvToLonLat(g503, u, v);
      const m = lonLatToMerc(ll.lon, ll.lat);
      const r = mercToUV(gu, m.x, m.y);
      const ref = lonLatToUV(g503, ll.lon, ll.lat);
      expect(Math.abs(r.u - ref.u)).toBeLessThan(1e-9);
      expect(Math.abs(r.v - ref.v)).toBeLessThan(1e-9);
      expect(Math.abs(r.u - u)).toBeLessThan(1e-9);
    }
  });

  it("puts pixel centres at integer pixel coords", () => {
    expect(uvToPixel(0.5 / 512, 0.5 / 512)).toEqual({ x: 0, y: 0 });
    expect(uvToPixel(1, 1)).toEqual({ x: 511.5, y: 511.5 });
  });

  it("mercQuad covers the whole image (densely sampled edges); unionQuad covers both", () => {
    const q = mercQuad(g503);
    const edge: [number, number][] = [];
    for (let i = 0; i <= 256; i++) {
      const t = i / 256;
      edge.push([t, 0], [t, 1], [0, t], [1, t]);
    }
    for (const [u, v] of edge) {
      const ll = uvToLonLat(g503, u, v);
      const m = lonLatToMerc(ll.lon, ll.lat);
      expect(m.x).toBeGreaterThanOrEqual(q[0]! - 1e-12);
      expect(m.x).toBeLessThanOrEqual(q[6]! + 1e-12);
      expect(m.y).toBeGreaterThanOrEqual(q[1]! - 1e-12);
      expect(m.y).toBeLessThanOrEqual(q[7]! + 1e-12);
    }
    const big = mercQuad(g501);
    const un = unionQuad(q, big);
    expect(un[0]).toBeCloseTo(Math.min(q[0]!, big[0]!), 12);
    expect(un[7]).toBeCloseTo(Math.max(q[7]!, big[7]!), 12);
  });
});
