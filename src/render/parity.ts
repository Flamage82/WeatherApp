/**
 * Dev-only GPU/CPU parity check for the shader's nested-range sampler (INTERP_GLSL `nestSlot`,
 * with u_smooth = 0) against `nestSlotSample` in `src/motion/nest.ts`: the interpolation at each of
 * `alphas`, and the nowcast at each of `leads` (with `flow` as the motion field in px/ms), all with
 * edge band `band` and the identity motion mapping; plus one nowcast case through a 2x motion grid
 * (`motion = { sx: 0.5, ox: 128, sy: 0.5, oy: 128 }`) with band 20. Renders (level, weight) for a grid
 * of pixel positions (fractional, and running past every edge of the frame) into an RGBA32F target
 * on an offscreen WebGL2 canvas, reads it back and compares both with the CPU. Needs
 * EXT_color_buffer_float (Chrome has it).
 */
import type { CellSize } from "../../shared/config";
import type { LevelField } from "../../shared/decodeFrame";
import { IDENTITY_AFFINE, type PixelAffine } from "../../shared/gnomonic";
import type { FlowField } from "../motion/flow";
import { nestSlotSample } from "../motion/nest";
import { linkProgram, uploadFlow, uploadLevels } from "./radarLayer";
import { INTERP_GLSL } from "./shaders";

const VS = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
${INTERP_GLSL}
uniform highp usampler2D u_a, u_b;
uniform highp sampler2D u_flow;
uniform ivec2 u_flowSize;
uniform float u_alpha, u_lead, u_band;
uniform vec4 u_maff;
uniform int u_cell;
uniform vec2 u_origin, u_step;
out vec4 fragColor;
void main() {
  vec2 p = u_origin + (gl_FragCoord.xy - 0.5) * u_step;
  vec2 r = nestSlot(u_a, u_b, u_flow, u_flowSize, u_alpha, u_lead, p, u_cell, u_band, u_maff);
  fragColor = vec4(r.x, r.y, 0.0, 1.0);
}
`;

type Sample = { level: number; weight: number };
type Worst = { x: number; y: number; gpu: Sample; cpu: Sample };

export type ParityResult = {
  cell: CellSize; alpha: number; leadMs: number; band: number; motion: PixelAffine;
  maxAbsDiff: { level: number; weight: number };
  worst: { level: Worst; weight: Worst };
};

/** The extra nowcast case's motion mapping: a motion grid at half the scale, as IDR504 -> IDR503. */
const HALF_MOTION: PixelAffine = { sx: 0.5, ox: 128, sy: 0.5, oy: 128 };

export function runParity(
  a: LevelField, b: LevelField, flow: FlowField, cell: CellSize, alphas = [0, 0.25, 0.5, 0.75, 1], N = 256,
  leads: number[] = [], band = 0,
): ParityResult[] {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("no WebGL2");
  if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("no EXT_color_buffer_float");

  const prog = linkProgram(gl, VS, FS);
  gl.useProgram(prog);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const tex = () => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  };
  const ta = tex(), tb = tex(), tf = tex();
  gl.activeTexture(gl.TEXTURE0); uploadLevels(gl, ta, a);
  gl.activeTexture(gl.TEXTURE1); uploadLevels(gl, tb, b);
  gl.activeTexture(gl.TEXTURE2); uploadFlow(gl, tf, flow);
  const U = (n: string) => gl.getUniformLocation(prog, n);
  gl.uniform1i(U("u_a"), 0);
  gl.uniform1i(U("u_b"), 1);
  gl.uniform1i(U("u_flow"), 2);
  gl.uniform2i(U("u_flowSize"), flow.gw, flow.gh);
  gl.uniform1i(U("u_cell"), cell);
  // u_smooth is left at its default 0: bilinear, as the CPU.

  const target = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, N, N);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  gl.viewport(0, 0, N, N);

  // Positions from -20.3 to ~531.6 px: fractional, and past every edge.
  const origin = -20.3, step = 552 / N + 0.0137;
  gl.uniform2f(U("u_origin"), origin, origin);
  gl.uniform2f(U("u_step"), step, step);

  const out = new Float32Array(N * N * 4);
  const results: ParityResult[] = [];
  const cases = [
    ...alphas.map((alpha) => ({ alpha, leadMs: 0, band, motion: IDENTITY_AFFINE })),
    ...leads.map((leadMs) => ({ alpha: 0, leadMs, band, motion: IDENTITY_AFFINE })),
    { alpha: 0, leadMs: leads.at(-1) ?? 1_800_000, band: 20, motion: HALF_MOTION },
  ];
  for (const { alpha, leadMs, band: bd, motion } of cases) {
    gl.uniform1f(U("u_alpha"), alpha);
    gl.uniform1f(U("u_lead"), leadMs);
    gl.uniform1f(U("u_band"), bd);
    gl.uniform4f(U("u_maff"), motion.sx, motion.ox, motion.sy, motion.oy);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, out);
    const slot = { a, b, flow, alpha, leadMs, cell, band: bd, motion, fresh: true };
    const zero: Worst = { x: 0, y: 0, gpu: { level: 0, weight: 0 }, cpu: { level: 0, weight: 0 } };
    const maxAbsDiff = { level: 0, weight: 0 };
    const worst = { level: zero, weight: zero };
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        const x = origin + c * step, y = origin + r * step;
        const gpu = { level: out[(r * N + c) * 4]!, weight: out[(r * N + c) * 4 + 1]! };
        const cpu = nestSlotSample(slot, x, y);
        for (const k of ["level", "weight"] as const) {
          const d = Math.abs(gpu[k] - cpu[k]);
          if (d > maxAbsDiff[k]) { maxAbsDiff[k] = d; worst[k] = { x, y, gpu, cpu }; }
        }
      }
    results.push({ cell, alpha, leadMs, band: bd, motion, maxAbsDiff, worst });
  }
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return results;
}
