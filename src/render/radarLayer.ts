import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl";
import { BLEND_PX, CELL_SIZE, type ProductId } from "../../shared/config";
import type { LevelField } from "../../shared/decodeFrame";
import type { PixelAffine } from "../../shared/gnomonic";
import type { RadarGeometry } from "../../shared/types";
import type { FlowField } from "../motion/flow";
import { buildRampLUT, LUT_SIZE } from "./colourRamp";
import { gnomonicUniforms, mercQuad, unionQuad, type GnomonicUniforms } from "./geometryUniforms";
import { FRAGMENT_SHADER, SHADER_SLOTS, VERTEX_SHADER } from "./shaders";

/** Most ranges drawn in one pass. Slot i uses texture units 3i..3i+2; the LUT uses unit 3·MAX_SLOTS. */
export const MAX_SLOTS = SHADER_SLOTS;
const LUT_UNIT = 3 * MAX_SLOTS;

/**
 * One range of the nest, as `NestSlot` in `src/motion/nest.ts`. `leadMs` > 0: the nowcast that far
 * past A (`flow` is then the motion field in the motion grid's px/ms, `motion` maps this range's px
 * to the motion grid's px, and b is unused). Else (a, b) are the pair, blended at `alpha` by the A->B
 * flow. `fresh: false` = a kept pair, drawn only where no fresh range has data.
 */
export type LayerSlot = {
  product: ProductId; geometry: RadarGeometry; a: LevelField; b: LevelField; flow: FlowField;
  alpha: number; leadMs: number; motion: PixelAffine; fresh: boolean;
};

/** Per-geometry values, cached because `mercQuad` samples the frame's edges. */
type Placed = { geom: RadarGeometry; gu: GnomonicUniforms; quad: Float32Array };

/** GPU copies of one product's current pair. Uploads happen lazily inside render(). */
type FrameTextures = {
  gl: WebGL2RenderingContext;
  a: WebGLTexture;
  b: WebGLTexture;
  flow: WebGLTexture;
  aData: LevelField | null;
  bData: LevelField | null;
  flowData: FlowField | null;
};

type Program = {
  prog: WebGLProgram;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  lut: WebGLTexture;
  loc: Record<string, WebGLUniformLocation | null>;
};

/** Map level lookup, from `?smooth=` (0 = bilinear, cr = Catmull-Rom, else B-spline). For comparing looks. */
const SMOOTH_MODE = (() => {
  const v = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("smooth");
  return v === "0" ? 0 : v === "cr" ? 2 : 1;
})();

const SLOT_UNIFORMS = [
  "u_a", "u_b", "u_flow", "u_flowSize", "u_alpha", "u_lead", "u_cell", "u_centre", "u_extent", "u_band", "u_maff", "u_on",
];
const UNIFORMS = [
  "u_matrix", "u_lut", "u_smooth",
  ...Array.from({ length: MAX_SLOTS }, (_, s) => SLOT_UNIFORMS.map((n) => `${n}${s}`)).flat(),
];

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`radar shader compile failed: ${log}`);
  }
  return sh;
}

export function linkProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`radar program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  return prog;
}

function nearestTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** Levels as R8UI (exact integers; read with texelFetch). Row 0 of the data = texel row 0 = top. */
export function uploadLevels(gl: WebGL2RenderingContext, t: WebGLTexture, f: LevelField): void {
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, f.width, f.height, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, f.data);
}

/**
 * A flow as RGBA floats per cell: rg = the detailed field, ba = the large-scale one (the detailed one
 * again if the flow has none, e.g. an A->B pair flow, whose slots read only rg).
 */
export function packFlow(f: FlowField): Float32Array {
  const n = f.gw * f.gh, large = f.large ?? f.data;
  const out = new Float32Array(n * 4);
  for (let k = 0; k < n; k++) {
    out[4 * k] = f.data[2 * k]!;
    out[4 * k + 1] = f.data[2 * k + 1]!;
    out[4 * k + 2] = large[2 * k]!;
    out[4 * k + 3] = large[2 * k + 1]!;
  }
  return out;
}

/** Flow as RGBA32F (see `packFlow`), gw x gh, cell (i, j) at texel (i, j). */
export function uploadFlow(gl: WebGL2RenderingContext, t: WebGLTexture, f: FlowField): void {
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, f.gw, f.gh, 0, gl.RGBA, gl.FLOAT, packFlow(f));
}

function deleteTextures(t: FrameTextures): void {
  t.gl.deleteTexture(t.a);
  t.gl.deleteTexture(t.b);
  t.gl.deleteTexture(t.flow);
}

let nextId = 0;

/**
 * MapLibre custom layer drawing up to MAX_SLOTS ranges of one radar nested in one pass, finest
 * first, exactly as `sampleNested` in `src/motion/nest.ts` (the shader's `nestSlot` is a port of
 * `nestSlotSample`): each range's pair (A, B) warped and blended at `alpha` by its A->B flow, or its
 * nowcast `leadMs` past A moved by the shared motion field, weighted down across its edge band
 * (`BLEND_PX`), reprojected from the frame's gnomonic projection onto Web Mercator and coloured with
 * the ramp. Mercator only (no globe).
 *
 * Textures are kept per product, so a product drawn in consecutive `setSlots` calls reuses (and,
 * playing forward, swaps) its uploads. A product dropped from the slots has its textures freed at
 * the next `render` (or `releaseTextures`). `onRemove` frees everything; after a re-add (style
 * change) the next render re-uploads every slot into the new context.
 *
 * Levels are interpolated between native cell centres, k = CELL_SIZE[product].
 */
export class RadarLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private slots: LayerSlot[] = [];
  private placed = new Map<ProductId, Placed>();

  private map: MlMap | null = null;
  private program: Program | null = null;
  private tex = new Map<ProductId, FrameTextures>();

  constructor(id = `radar-${nextId++}`) {
    this.id = id;
  }

  /** The ranges to draw, finest first; at most MAX_SLOTS, one per product. */
  setSlots(slots: LayerSlot[]): void {
    if (slots.length > MAX_SLOTS) throw new Error(`RadarLayer draws at most ${MAX_SLOTS} slots, got ${slots.length}`);
    if (new Set(slots.map((s) => s.product)).size !== slots.length) throw new Error("RadarLayer slots repeat a product");
    this.slots = slots.map((s) => ({ ...s, alpha: Math.min(1, Math.max(0, s.alpha)), leadMs: Math.max(0, s.leadMs) }));
    for (const s of slots) {
      const pl = this.placed.get(s.product);
      if (!pl || pl.geom !== s.geometry) {
        this.placed.set(s.product, { geom: s.geometry, gu: gnomonicUniforms(s.geometry), quad: mercQuad(s.geometry) });
      }
    }
    for (const p of this.placed.keys()) if (!slots.some((s) => s.product === p)) this.placed.delete(p);
    this.map?.triggerRepaint();
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    const prog = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    const loc: Program["loc"] = {};
    for (const n of UNIFORMS) loc[n] = gl.getUniformLocation(prog, n);

    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const aPos = gl.getAttribLocation(prog, "a_merc");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Stops sit exactly on LUT entries, so LINEAR filtering here reproduces rampColour.
    const lut = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, LUT_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildRampLUT());

    this.program = { prog, vao, vbo, lut, loc };
  }

  onRemove(_map: MlMap, gl: WebGL2RenderingContext): void {
    if (this.program) {
      gl.deleteProgram(this.program.prog);
      gl.deleteVertexArray(this.program.vao);
      gl.deleteBuffer(this.program.vbo);
      gl.deleteTexture(this.program.lut);
    }
    this.program = null;
    this.map = null;
    // The slots stay: a re-add (style change) re-uploads them into its context on the next render.
    this.releaseTextures();
  }

  /** Free every product's frame textures (the slots stay; the next render re-uploads them). */
  releaseTextures(): void {
    for (const t of this.tex.values()) deleteTextures(t);
    this.tex.clear();
  }

  /** Free the textures of products no longer in the slots. */
  private releaseUnused(): void {
    for (const [p, t] of this.tex) {
      if (this.slots.some((s) => s.product === p)) continue;
      deleteTextures(t);
      this.tex.delete(p);
    }
  }

  /** Make sure slot `s`'s pair is on the GPU in `gl`. */
  private prepare(gl: WebGL2RenderingContext, s: LayerSlot): FrameTextures {
    let t = this.tex.get(s.product);
    if (t && t.gl !== gl) t = undefined; // different (e.g. restored) context
    if (!t) {
      t = { gl, a: nearestTexture(gl), b: nearestTexture(gl), flow: nearestTexture(gl), aData: null, bData: null, flowData: null };
      this.tex.set(s.product, t);
    }
    // Playing forward, the new A is usually the old B: swap handles instead of re-uploading.
    if (s.a !== t.aData && s.a === t.bData) {
      [t.a, t.b] = [t.b, t.a];
      [t.aData, t.bData] = [t.bData, t.aData];
    }
    if (s.a !== t.aData) { uploadLevels(gl, t.a, s.a); t.aData = s.a; }
    if (s.b !== t.bData) { uploadLevels(gl, t.b, s.b); t.bData = s.b; }
    if (s.flow !== t.flowData) { uploadFlow(gl, t.flow, s.flow); t.flowData = s.flow; }
    return t;
  }

  private bindSlot(gl: WebGL2RenderingContext, P: Program, i: number, s: LayerSlot, t: FrameTextures): void {
    const u = (n: string) => P.loc[`${n}${i}`] ?? null;
    const unit = i * 3;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.a);
    gl.activeTexture(gl.TEXTURE0 + unit + 1);
    gl.bindTexture(gl.TEXTURE_2D, t.b);
    gl.activeTexture(gl.TEXTURE0 + unit + 2);
    gl.bindTexture(gl.TEXTURE_2D, t.flow);
    gl.uniform1i(u("u_a"), unit);
    gl.uniform1i(u("u_b"), unit + 1);
    gl.uniform1i(u("u_flow"), unit + 2);
    const gu = this.placed.get(s.product)!.gu, m = s.motion;
    gl.uniform2i(u("u_flowSize"), s.flow.gw, s.flow.gh);
    gl.uniform1f(u("u_alpha"), s.alpha);
    gl.uniform1f(u("u_lead"), s.leadMs);
    gl.uniform1i(u("u_cell"), CELL_SIZE[s.product]);
    gl.uniform2f(u("u_centre"), gu.lat0, gu.lon0);
    gl.uniform4f(u("u_extent"), gu.xMin, gu.xMax, gu.yMin, gu.yMax);
    gl.uniform1f(u("u_band"), BLEND_PX[s.product]);
    gl.uniform4f(u("u_maff"), m.sx, m.ox, m.sy, m.oy);
    gl.uniform1i(u("u_on"), s.fresh ? 1 : 2);
  }

  /** An absent slot: off, its samplers on slot 0's units (samplers must point at valid textures). */
  private bindAbsent(gl: WebGL2RenderingContext, P: Program, i: number): void {
    const u = (n: string) => P.loc[`${n}${i}`] ?? null;
    gl.uniform1i(u("u_a"), 0);
    gl.uniform1i(u("u_b"), 1);
    gl.uniform1i(u("u_flow"), 2);
    gl.uniform1i(u("u_on"), 0);
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const P = this.program;
    if (!P) return;
    this.releaseUnused();
    const slots = this.slots;
    if (slots.length === 0) return;
    const texs = slots.map((s) => this.prepare(gl, s));
    const quad = slots.map((s) => this.placed.get(s.product)!.quad).reduce(unionQuad);

    gl.useProgram(P.prog);
    gl.uniformMatrix4fv(P.loc.u_matrix!, false, options.defaultProjectionData.mainMatrix as Float32List);
    gl.uniform1i(P.loc.u_smooth!, SMOOTH_MODE);
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (i < slots.length) this.bindSlot(gl, P, i, slots[i]!, texs[i]!);
      else this.bindAbsent(gl, P, i);
    }
    gl.activeTexture(gl.TEXTURE0 + LUT_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, P.lut);
    gl.uniform1i(P.loc.u_lut!, LUT_UNIT);

    gl.bindVertexArray(P.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, P.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.DYNAMIC_DRAW);
    // MapLibre's custom-layer blend is ONE, ONE_MINUS_SRC_ALPHA; the shader outputs premultiplied.
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
