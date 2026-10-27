import { describe, expect, it } from "vitest";
import type { CustomRenderMethodInput, Map as MlMap } from "maplibre-gl";
import { parseMapFile } from "../../worker/mapFile";
import m503 from "../../worker/__fixtures__/IDR503.map?raw";
import m504 from "../../shared/__fixtures__/IDR504.map?raw";
import type { LevelField } from "../../shared/decodeFrame";
import { ZERO_FLOW } from "../motion/flow";
import { RadarLayer } from "./radarLayer";

/**
 * Minimal WebGL2 stand-in: every method is a no-op returning a fresh object, except that textures
 * are tracked (created minus deleted = live) and status queries report success. Enough to drive
 * RadarLayer's lifecycle without a GPU.
 */
function mockGl() {
  const live = new Set<object>();
  const calls: { name: string; args: unknown[] }[] = [];
  const special: Record<string, (...a: unknown[]) => unknown> = {
    createTexture: () => { const t = {}; live.add(t); return t; },
    deleteTexture: (t) => { live.delete(t as object); },
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getAttribLocation: () => 0,
    getUniformLocation: (_p, name) => ({ name }),
  };
  const gl = new Proxy({}, {
    get(_t, name: string) {
      return (...args: unknown[]) => {
        calls.push({ name, args });
        return special[name] ? special[name]!(...args) : {};
      };
    },
  }) as unknown as WebGL2RenderingContext;
  /** Last values set per uniform name, from uniform* calls since `calls` was last cleared. */
  const uniforms = () => {
    const u: Record<string, unknown[]> = {};
    for (const c of calls)
      if (c.name.startsWith("uniform")) u[(c.args[0] as { name: string }).name] = c.args.slice(1);
    return u;
  };
  return { gl, live, calls, uniforms };
}

const fakeMap = () => ({ triggerRepaint: () => {} }) as unknown as MlMap;
const opts = { defaultProjectionData: { mainMatrix: new Float32Array(16) } } as unknown as CustomRenderMethodInput;
const field = (): LevelField => ({ width: 512, height: 512, data: new Uint8Array(512 * 512) });

function loaded(id: string, map: string) {
  const l = new RadarLayer(id);
  l.setGeometry(parseMapFile(map));
  l.setPair(field(), field(), ZERO_FLOW, 0.5);
  return l;
}

describe("RadarLayer crossfade hand-off", () => {
  it("frees every texture after A -> B hand-off and B's later removal", () => {
    const { gl, live } = mockGl();
    const map = fakeMap();
    const a = loaded("a", m503), b = loaded("b", m504);
    a.onAdd(map, gl);
    a.setCrossfade(b, 0.5);
    a.render(gl, opts);
    expect(live.size).toBe(1 + 3 + 3); // A's LUT + A's frame textures + B's (borrowed context)

    // Hand-off: remove A, add B.
    a.onRemove(map, gl);
    expect(live.size).toBe(3); // B's frame textures survive for reuse
    b.onAdd(map, gl);
    b.render(gl, opts);
    expect(live.size).toBe(1 + 3); // B's LUT + the same 3 frame textures (no re-create)

    b.onRemove(map, gl);
    expect(live.size).toBe(0); // regression: B's stale `owner` used to keep these alive
  });

  it("adding the target first detaches it from its old owner", () => {
    const { gl, live, calls, uniforms } = mockGl();
    const map = fakeMap();
    const a = loaded("a", m503), b = loaded("b", m504);
    a.onAdd(map, gl);
    a.setCrossfade(b, 0.5);
    calls.length = 0;
    a.render(gl, opts);
    expect(uniforms().u_mix).toEqual([0.5]);
    expect(uniforms().u_extent1).not.toEqual(uniforms().u_extent0); // slot 1 = B

    b.onAdd(map, gl); // other order: add B, then remove A

    // A no longer draws B: mix 0, and slot 1 just repeats A's own data.
    calls.length = 0;
    a.render(gl, opts);
    expect(uniforms().u_mix).toEqual([0]);
    expect(uniforms().u_extent1).toEqual(uniforms().u_extent0);

    a.onRemove(map, gl);
    b.onRemove(map, gl);
    expect(live.size).toBe(0);
  });

  it("refuses a crossfade target that is on the map", () => {
    const { gl } = mockGl();
    const map = fakeMap();
    const a = loaded("a", m503), b = loaded("b", m504);
    a.onAdd(map, gl);
    b.onAdd(map, gl);
    expect(() => a.setCrossfade(b, 0.5)).toThrow();
  });

  it("passes the product's native cell size to the shader", () => {
    const { gl, uniforms } = mockGl();
    const a = loaded("a", m503);
    a.onAdd(fakeMap(), gl);
    a.render(gl, opts);
    // Slot 1 reuses slot 0's data when not crossfading; both are CELL_SIZE.IDR503 = 2.
    expect(uniforms().u_cell0).toEqual([2]);
    expect(uniforms().u_cell1).toEqual([2]);
  });
});
