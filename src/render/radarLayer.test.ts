import { describe, expect, it } from "vitest";
import type { CustomRenderMethodInput, Map as MlMap } from "maplibre-gl";
import { parseMapFile } from "../../worker/mapFile";
import m503 from "../../worker/__fixtures__/IDR503.map?raw";
import m501 from "../../shared/__fixtures__/IDR501.map?raw";
import m502 from "../../shared/__fixtures__/IDR502.map?raw";
import m504 from "../../shared/__fixtures__/IDR504.map?raw";
import m663 from "../../shared/__fixtures__/IDR663.map?raw";
import m664 from "../../shared/__fixtures__/IDR664.map?raw";
import type { LevelField } from "../../shared/decodeFrame";
import { IDENTITY_AFFINE } from "../../shared/gnomonic";
import { ZERO_FLOW } from "../motion/flow";
import { MAX_SLOTS, RadarLayer, type LayerSlot } from "./radarLayer";

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

function slot(map: string, fresh = true): LayerSlot {
  const geometry = parseMapFile(map);
  return {
    product: geometry.product, geometry, a: field(), b: field(), flow: ZERO_FLOW,
    alpha: 0.5, leadMs: 0, motion: IDENTITY_AFFINE, fresh,
  };
}

describe("RadarLayer slots", () => {
  it("passes each slot's state and band, finest first, with absent slots off", () => {
    const { gl, calls, uniforms } = mockGl();
    const l = new RadarLayer();
    l.onAdd(fakeMap(), gl);
    l.setSlots([slot(m504, true), slot(m503, false)]);
    calls.length = 0;
    l.render(gl, opts);
    const u = uniforms();
    expect(u.u_on0).toEqual([1]);
    expect(u.u_on1).toEqual([2]);
    expect(u.u_on2).toEqual([0]);
    expect(u.u_on3).toEqual([0]);
    expect(u.u_band0).toEqual([20]);
    expect(u.u_band1).toEqual([12]);
  });

  it("releases the old products' textures when the slots are replaced (radar switch)", () => {
    const { gl, live } = mockGl();
    const l = new RadarLayer();
    l.onAdd(fakeMap(), gl);
    const lut = new Set(live);
    l.setSlots([slot(m504), slot(m503)]);
    l.render(gl, opts);
    const marburg = [...live].filter((t) => !lut.has(t));
    expect(marburg).toHaveLength(6);

    l.setSlots([slot(m664), slot(m663)]);
    l.render(gl, opts);
    expect(marburg.filter((t) => live.has(t))).toHaveLength(0); // every Marburg texture deleted
    expect(live.size - lut.size).toBe(6); // only Stapylton's 6 frame textures are live
  });

  it("re-creates every slot's textures in a new context after remove and re-add (style switch)", () => {
    const first = mockGl();
    const map = fakeMap();
    const l = new RadarLayer();
    l.onAdd(map, first.gl);
    l.setSlots([slot(m504), slot(m503)]);
    l.render(first.gl, opts);
    l.onRemove(map, first.gl);
    expect(first.live.size).toBe(0);

    const second = mockGl();
    l.onAdd(map, second.gl);
    const lut = second.live.size;
    l.render(second.gl, opts);
    expect(second.live.size - lut).toBe(3 * 2);
  });

  it("refuses more than MAX_SLOTS slots", () => {
    const l = new RadarLayer();
    expect(MAX_SLOTS).toBe(4);
    expect(() => l.setSlots([m504, m503, m502, m501, m664].map((m) => slot(m)))).toThrow();
  });
});
