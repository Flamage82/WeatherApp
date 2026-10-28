import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl";
import { CELL_SIZE, type CellSize } from "../../shared/config";
import type { LevelField } from "../../shared/decodeFrame";
import type { RadarGeometry } from "../../shared/types";
import type { FlowField } from "../motion/flow";
import { buildRampLUT, LUT_SIZE } from "./colourRamp";
import { gnomonicUniforms, mercQuad, unionQuad, type GnomonicUniforms } from "./geometryUniforms";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders";

/** `leadMs` > 0: the nowcast that far past A (`flow` is then the forecast flow, px/ms; b is unused). */
type Pair = { a: LevelField; b: LevelField; flow: FlowField; alpha: number; leadMs: number };

/** GPU copies of one layer's current pair. Uploads happen lazily inside render(). */
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

const UNIFORMS = [
  "u_matrix", "u_mix", "u_lut", "u_smooth",
  ...[0, 1].flatMap((s) =>
    ["u_a", "u_b", "u_flow", "u_flowSize", "u_alpha", "u_lead", "u_cell", "u_centre", "u_extent"].map((n) => `${n}${s}`)),
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

/** Flow as RG32F, gw x gh, cell (i, j) at texel (i, j). */
export function uploadFlow(gl: WebGL2RenderingContext, t: WebGLTexture, f: FlowField): void {
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, f.gw, f.gh, 0, gl.RG, gl.FLOAT, f.data);
}

let nextId = 0;

/**
 * MapLibre custom layer drawing one radar product: frame pair (A, B) warped and blended at
 * `alpha` by the A->B flow (exactly `sampleInterpolated`), or the nowcast `leadMs` past A (exactly
 * `sampleForecast`, faded by `forecastOpacity`), reprojected from the frame's gnomonic
 * projection onto Web Mercator, coloured with the ramp. Mercator only (no globe).
 *
 * Crossfade (range changes): `setCrossfade(other, mix)` makes THIS layer also draw `other`, in the
 * same pass, as `(1-mix)·this + mix·other` in premultiplied colour, so there is no see-through dip
 * mid-fade. `other` must NOT be on the map at the same time (setCrossfade throws); it borrows
 * this layer's GL context. To finish a fade, remove this layer and add `other`: its textures carry
 * over, and either step (this.onRemove or other.onAdd) clears the link. A target that is dropped
 * without ever being added must be freed with `releaseTextures()`.
 *
 * Levels are interpolated between native cell centres, k = CELL_SIZE[geometry.product].
 */
export class RadarLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private geom: RadarGeometry | null = null;
  /** Native cell size of the product, from CELL_SIZE via the geometry. */
  private cell: CellSize = 1;
  private gu: GnomonicUniforms | null = null;
  private quad: Float32Array | null = null;
  private pair: Pair | null = null;
  private other: RadarLayer | null = null;
  private mix = 0;
  private owner: RadarLayer | null = null;

  private map: MlMap | null = null;
  private program: Program | null = null;
  private tex: FrameTextures | null = null;

  constructor(id = `radar-${nextId++}`) {
    this.id = id;
  }

  setGeometry(g: RadarGeometry): void {
    this.geom = g;
    this.cell = CELL_SIZE[g.product];
    this.gu = gnomonicUniforms(g);
    this.quad = mercQuad(g);
    this.repaint();
  }

  setPair(a: LevelField, b: LevelField, flow: FlowField, alpha: number, leadMs = 0): void {
    this.pair = { a, b, flow, alpha: Math.min(1, Math.max(0, alpha)), leadMs: Math.max(0, leadMs) };
    this.repaint();
  }

  setCrossfade(other: RadarLayer | null, mix: number): void {
    if (other === this) throw new Error("RadarLayer cannot crossfade with itself");
    if (other?.map) throw new Error("RadarLayer crossfade target must not be on the map itself");
    if (this.other && this.other !== other) this.other.owner = null;
    this.other = other;
    if (other) other.owner = this;
    this.mix = other ? Math.min(1, Math.max(0, mix)) : 0;
    this.repaint();
  }

  private repaint(): void {
    this.map?.triggerRepaint();
    this.owner?.repaint();
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext): void {
    // Hand-off: a layer that was another layer's crossfade target now draws itself; detach so the
    // old owner stops drawing it too (and so our onRemove frees our textures later).
    if (this.owner) {
      const o = this.owner;
      o.other = null;
      o.mix = 0;
      this.owner = null;
      o.repaint();
    }
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
    // Drop the crossfade link. The target keeps its textures (it is usually added next, and reuses
    // them); if it is discarded instead, the caller frees them with releaseTextures().
    if (this.other) {
      this.other.owner = null;
      this.other = null;
      this.mix = 0;
    }
    // Keep this layer's frame textures if it is still being drawn as someone's crossfade target.
    if (!this.owner) this.releaseTextures();
  }

  /** Free this layer's frame textures (call when discarding a layer that was only a crossfade target). */
  releaseTextures(): void {
    const t = this.tex;
    if (!t) return;
    t.gl.deleteTexture(t.a);
    t.gl.deleteTexture(t.b);
    t.gl.deleteTexture(t.flow);
    this.tex = null;
  }

  /** Make sure this layer's pair is on the GPU in `gl`; returns null if there's nothing to draw. */
  private prepare(gl: WebGL2RenderingContext): FrameTextures | null {
    const p = this.pair;
    if (!p || !this.gu) return null;
    if (this.tex && this.tex.gl !== gl) this.tex = null; // different (e.g. restored) context
    if (!this.tex) {
      this.tex = { gl, a: nearestTexture(gl), b: nearestTexture(gl), flow: nearestTexture(gl), aData: null, bData: null, flowData: null };
    }
    const t = this.tex;
    // Playing forward, the new A is usually the old B: swap handles instead of re-uploading.
    if (p.a !== t.aData && p.a === t.bData) {
      [t.a, t.b] = [t.b, t.a];
      [t.aData, t.bData] = [t.bData, t.aData];
    }
    if (p.a !== t.aData) { uploadLevels(gl, t.a, p.a); t.aData = p.a; }
    if (p.b !== t.bData) { uploadLevels(gl, t.b, p.b); t.bData = p.b; }
    if (p.flow !== t.flowData) { uploadFlow(gl, t.flow, p.flow); t.flowData = p.flow; }
    return t;
  }

  private bindSlot(gl: WebGL2RenderingContext, P: Program, slot: 0 | 1, layer: RadarLayer, t: FrameTextures): void {
    const u = (n: string) => P.loc[`${n}${slot}`] ?? null;
    const unit = slot * 3;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.a);
    gl.activeTexture(gl.TEXTURE0 + unit + 1);
    gl.bindTexture(gl.TEXTURE_2D, t.b);
    gl.activeTexture(gl.TEXTURE0 + unit + 2);
    gl.bindTexture(gl.TEXTURE_2D, t.flow);
    gl.uniform1i(u("u_a"), unit);
    gl.uniform1i(u("u_b"), unit + 1);
    gl.uniform1i(u("u_flow"), unit + 2);
    const pair = layer.pair!, gu = layer.gu!;
    gl.uniform2i(u("u_flowSize"), pair.flow.gw, pair.flow.gh);
    gl.uniform1f(u("u_alpha"), pair.alpha);
    gl.uniform1f(u("u_lead"), pair.leadMs);
    gl.uniform1i(u("u_cell"), layer.cell);
    gl.uniform2f(u("u_centre"), gu.lat0, gu.lon0);
    gl.uniform4f(u("u_extent"), gu.xMin, gu.xMax, gu.yMin, gu.yMax);
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const P = this.program;
    if (!P) return;
    const own = this.prepare(gl);
    const other = this.other && this.mix > 0 ? this.other : null;
    const theirs = other ? other.prepare(gl) : null;
    // Effective mix: with one side missing, draw the other side alone.
    let mix = this.mix;
    if (!theirs) mix = 0;
    if (!own) mix = 1;
    if (!own && !theirs) return;

    const quad = own && theirs ? unionQuad(this.quad!, other!.quad!) : own ? this.quad! : other!.quad!;

    gl.useProgram(P.prog);
    gl.uniformMatrix4fv(P.loc.u_matrix!, false, options.defaultProjectionData.mainMatrix as Float32List);
    gl.uniform1f(P.loc.u_mix!, mix);
    gl.uniform1i(P.loc.u_smooth!, SMOOTH_MODE);
    // Unbound slots still need valid textures of the right type; reuse the side that exists.
    this.bindSlot(gl, P, 0, own ? this : other!, (own ?? theirs)!);
    this.bindSlot(gl, P, 1, theirs ? other! : this, (theirs ?? own)!);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, P.lut);
    gl.uniform1i(P.loc.u_lut!, 6);

    gl.bindVertexArray(P.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, P.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.DYNAMIC_DRAW);
    // MapLibre's custom-layer blend is ONE, ONE_MINUS_SRC_ALPHA; the shader outputs premultiplied.
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /** The geometry this layer draws with (for callers that need the frame's footprint). */
  get geometry(): RadarGeometry | null {
    return this.geom;
  }
}
