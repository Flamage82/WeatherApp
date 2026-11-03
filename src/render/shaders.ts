import { MAX_NOWCAST_STEPS, NOWCAST_STEP_MS, RELAX_MS } from "../motion/advect";
import { DATA_MARGIN_PX } from "../motion/nest";

/**
 * GLSL ES 3.00 sources for the radar layer.
 *
 * INTERP_GLSL is a line-for-line port of `src/motion/nest.ts` `edgeDist`, `edgeWeight` and
 * `nestSlotSample` (as `nestSlot`), `src/motion/advect.ts` `advectBack` and `nowcastVelocity`,
 * `src/motion/interpolate.ts` `bilinear`, and `src/motion/flow.ts` `flowAt`.
 * Both bilinear lookups are done by hand with `texelFetch`, not hardware filtering:
 *  - level textures (R8UI): out-of-bounds taps read 0 exactly, which WebGL2 can't express with
 *    wrap modes (no clamp-to-border), and the tap positions match the CPU (value at integer coords);
 *  - flow texture (RGBA32F, rg = detailed field, ba = large-scale field): float textures aren't filterable without OES_texture_float_linear, and
 *    the CPU's grid mapping (cell i centred at (i+1)*512/(gw+1), clamped to the edge cell) is not
 *    the texture-space mapping LINEAR filtering would use anyway.
 * So the GPU result equals the CPU result up to float32 rounding. The same chunk is used by the
 * parity check in `parity.ts`.
 *
 * Display-only exception: `u_smooth` swaps the bilinear level lookup for a smoother cubic one on
 * the map (1 = cubic B-spline, the default; 2 = Catmull-Rom clamped to the 4 nearest cells).
 * The CPU mirror and the parity check stay bilinear (u_smooth = 0, the uniform's default).
 */
export const INTERP_GLSL = /* glsl */ `
// Native cell c (k x k pixels, phase 0) has its value at texel c*k; cells outside the frame read 0.
float levelTap(highp usampler2D t, ivec2 c, int k) {
  int n = 512 / k;
  if (c.x < 0 || c.y < 0 || c.x >= n || c.y >= n) return 0.0;
  return float(texelFetch(t, c * k, 0).r);
}

// Bilinear between native cell centres (pixel k*c + (k-1)/2); k = 1 is per-pixel with pixel
// (ix, iy) at integer coords. Row 0 = top of the image. As interpolate.ts bilinear().
float bilinearLevel(highp usampler2D t, vec2 p, int k) {
  float kf = float(k);
  vec2 q = (p - 0.5 * (kf - 1.0)) / kf;
  vec2 q0 = floor(q);
  vec2 f = q - q0;
  ivec2 c = ivec2(q0);
  float v00 = levelTap(t, c, k);
  float v10 = levelTap(t, c + ivec2(1, 0), k);
  float v01 = levelTap(t, c + ivec2(0, 1), k);
  float v11 = levelTap(t, c + ivec2(1, 1), k);
  return (v00 * (1.0 - f.x) + v10 * f.x) * (1.0 - f.y) + (v01 * (1.0 - f.x) + v11 * f.x) * f.y;
}

uniform int u_smooth; // 0 = bilinear, 1 = cubic B-spline, 2 = Catmull-Rom (display only)

// Cubic B-spline weights for taps -1..2: all >= 0 and summing to 1, so it never exceeds the
// neighbourhood max (no invented rain), but it softens a lone cell's peak.
vec4 bsplineWeights(float t) {
  float t2 = t * t, t3 = t2 * t, s = 1.0 - t;
  return vec4(s * s * s, 3.0 * t3 - 6.0 * t2 + 4.0, -3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0, t3) / 6.0;
}

// Catmull-Rom weights for taps -1..2: passes through the cell values (keeps peaks) but overshoots,
// so the caller clamps to the 4 nearest cells.
vec4 catmullWeights(float t) {
  float t2 = t * t, t3 = t2 * t;
  return vec4(-t3 + 2.0 * t2 - t, 3.0 * t3 - 5.0 * t2 + 2.0, -3.0 * t3 + 4.0 * t2 + t, t3 - t2) * 0.5;
}

// 4x4-tap cubic between native cell centres; same cell mapping as bilinearLevel.
float cubicLevel(highp usampler2D t, vec2 p, int k, bool catmull) {
  float kf = float(k);
  vec2 q = (p - 0.5 * (kf - 1.0)) / kf;
  vec2 q0 = floor(q);
  vec2 f = q - q0;
  ivec2 c = ivec2(q0);
  vec4 wx = catmull ? catmullWeights(f.x) : bsplineWeights(f.x);
  vec4 wy = catmull ? catmullWeights(f.y) : bsplineWeights(f.y);
  float s = 0.0, lo = 1e9, hi = -1e9;
  for (int j = 0; j < 4; j++) {
    float row = 0.0;
    for (int i = 0; i < 4; i++) {
      float v = levelTap(t, c + ivec2(i - 1, j - 1), k);
      row += wx[i] * v;
      if ((i == 1 || i == 2) && (j == 1 || j == 2)) { lo = min(lo, v); hi = max(hi, v); }
    }
    s += wy[j] * row;
  }
  return catmull ? clamp(s, lo, hi) : s;
}

float levelAt(highp usampler2D t, vec2 p, int k) {
  if (u_smooth == 1) return cubicLevel(t, p, k, false);
  if (u_smooth == 2) return cubicLevel(t, p, k, true);
  return bilinearLevel(t, p, k);
}

// flow.ts flowAt, both fields at once: cell (i, j) centred at full-res ((i+1)*512/(gw+1), (j+1)*512/(gh+1));
// clamped to edge. Returns (detailed.xy, large-scale.zw); an A->B pair flow's large-scale half is unused.
vec4 flowAt(highp sampler2D t, ivec2 size, vec2 p) {
  vec2 gs = vec2(size);
  vec2 g = clamp(p * (gs + 1.0) / 512.0 - 1.0, vec2(0.0), gs - 1.0);
  vec2 g0 = floor(g);
  vec2 f = g - g0;
  ivec2 i0 = ivec2(g0);
  ivec2 i1 = min(i0 + 1, size - 1);
  vec4 v00 = texelFetch(t, i0, 0);
  vec4 v10 = texelFetch(t, ivec2(i1.x, i0.y), 0);
  vec4 v01 = texelFetch(t, ivec2(i0.x, i1.y), 0);
  vec4 v11 = texelFetch(t, i1, 0);
  return (v00 * (1.0 - f.x) + v10 * f.x) * (1.0 - f.y) + (v01 * (1.0 - f.x) + v11 * f.x) * f.y;
}

// nest.ts edgeDist: px inside the data area (the frame minus its no-data border), from pixel edges;
// negative outside.
float edgeDist(vec2 p) {
  const float lo = ${(DATA_MARGIN_PX - 0.5).toFixed(1)};
  const float hi = ${(511.5 - DATA_MARGIN_PX).toFixed(1)};
  return min(min(p.x - lo, hi - p.x), min(p.y - lo, hi - p.y));
}

// nest.ts edgeWeight: 0 outside; band 0 = hard edge; else smoothstep across the band.
float edgeWeight(float d, float band) {
  if (d < 0.0) return 0.0;
  if (band == 0.0) return 1.0;
  float t = clamp(d / band, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// THE nested-range formula, nest.ts nestSlotSample: (level, weight) of one slot at its own pixel p.
// lead > 0: nowcast; fl is the motion field in the motion grid's px/ms and maff = (sx, ox, sy, oy)
// maps this slot's px to the motion grid's px. The loop is advect.ts advectBack (with nowcastVelocity):
// step back through the motion in motion px, easing from the detailed field to the large-scale one.
// Else A/B interpolation by the A->B flow fl:
//   F = flowAt(p); wa = A(p - alpha*F); wb = B(p + (1-alpha)*F); min((1-alpha)*wa + alpha*wb, max(wa, wb)).
// The weight is the smallest edge weight over p and the source point(s).
vec2 nestSlot(highp usampler2D a, highp usampler2D b, highp sampler2D fl, ivec2 fsize, float alpha, float lead,
              vec2 p, int k, float band, vec4 maff) {
  float w = edgeWeight(edgeDist(p), band);
  if (w <= 0.0) return vec2(0.0, 0.0);
  if (lead > 0.0) {
    vec2 q = vec2(maff.x * p.x + maff.y, maff.z * p.y + maff.w);
    float tau = lead;
    for (int i = 0; i < ${MAX_NOWCAST_STEPS}; i++) {
      if (tau <= 0.0) break;
      float h = min(${NOWCAST_STEP_MS.toFixed(1)}, tau);
      vec4 fv = flowAt(fl, fsize, q);
      float r = clamp((tau - 0.5 * h) / ${RELAX_MS.toFixed(1)}, 0.0, 1.0);
      vec2 v = fv.xy + (fv.zw - fv.xy) * r;
      q -= h * v;
      tau -= h;
    }
    vec2 s = vec2((q.x - maff.y) / maff.x, (q.y - maff.w) / maff.z);
    w = min(w, edgeWeight(edgeDist(s), band));
    return vec2(levelAt(a, s, k), w);
  }
  vec2 f = flowAt(fl, fsize, p).xy;
  vec2 pa = p - alpha * f, pb = p + (1.0 - alpha) * f;
  w = min(w, min(edgeWeight(edgeDist(pa), band), edgeWeight(edgeDist(pb), band)));
  float wa = levelAt(a, pa, k), wb = levelAt(b, pb, k);
  return vec2(min((1.0 - alpha) * wa + alpha * wb, max(wa, wb)), w);
}
`;

export const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;
uniform mat4 u_matrix;
in vec2 a_merc;
out vec2 v_merc;
void main() {
  v_merc = a_merc;
  gl_Position = u_matrix * vec4(a_merc, 0.0, 1.0);
}
`;

/** Slots in the fragment shader (ranges drawn in one pass); radarLayer.ts MAX_SLOTS. */
export const SHADER_SLOTS = 4;

const perSlot = (f: (i: number) => string) => Array.from({ length: SHADER_SLOTS }, (_, i) => f(i)).join("\n");

/**
 * Up to SHADER_SLOTS ranges ("slots") nested in one pass, finest first: nest.ts `sampleNested`.
 * Per slot i: gnomonic tangent point (radians), image extent in tangent-plane units, the A/B level
 * textures, the A->B flow texture and the blend position alpha; or, with u_lead > 0, the nowcast:
 * A = the newest frame, the flow texture = the motion field (px/ms in the motion grid, mapped by
 * u_maff), drawn like any other frame. u_band = edge blend band (BLEND_PX), u_on = 0 absent,
 * 1 fresh, 2 stale (drawn only where no fresh slot has data, the finest first).
 */
export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;

${INTERP_GLSL}

const float PI = 3.141592653589793;

${perSlot((i) => `uniform highp usampler2D u_a${i}, u_b${i};
uniform highp sampler2D u_flow${i};
uniform ivec2 u_flowSize${i};
uniform float u_alpha${i};
uniform float u_lead${i};      // nowcast lead (ms) past A; 0 = interpolate A/B
uniform int u_cell${i};        // native cell size k (CELL_SIZE[product])
uniform vec2 u_centre${i};     // (lat0, lon0) radians
uniform vec4 u_extent${i};     // (xMin, xMax, yMin, yMax)
uniform float u_band${i};      // edge blend band, px (BLEND_PX[product])
uniform vec4 u_maff${i};       // slot px -> motion px: (sx, ox, sy, oy)
uniform int u_on${i};          // 0 = absent, 1 = fresh, 2 = stale`)}
uniform sampler2D u_lut;             // 256 x 1 RGBA8, LINEAR

in vec2 v_merc;
out vec4 fragColor;

// lon/lat (radians) -> image uv (u right, v down), as shared/gnomonic.ts lonLatToUV.
vec2 gnomonicUV(vec2 lonLat, vec2 centre, vec4 ext) {
  float dl = lonLat.x - centre.y;
  float sp0 = sin(centre.x), cp0 = cos(centre.x);
  float sp = sin(lonLat.y), cp = cos(lonLat.y);
  float cdl = cos(dl);
  float cosC = sp0 * sp + cp0 * cp * cdl;
  float x = cp * sin(dl) / cosC;
  float y = (cp0 * sp - sp0 * cp * cdl) / cosC;
  return vec2((x - ext.x) / (ext.y - ext.x), (ext.w - y) / (ext.w - ext.z));
}

// Premultiplied ramp colour of a level; LUT entry i holds level i/255*15.
vec4 ramp(float level) {
  vec4 c = texture(u_lut, vec2((clamp(level, 0.0, 15.0) * 17.0 + 0.5) / 256.0, 0.5));
  return vec4(c.rgb * c.a, c.a);
}

void main() {
  vec2 lonLat = vec2(v_merc.x * 2.0 * PI - PI, atan(sinh(PI * (1.0 - 2.0 * v_merc.y))));
  // nest.ts sampleNested: fresh slots blend by weight, c = rem*w; the finest stale slot with data
  // is the fallback where no fresh slot has any. Once rem reaches 0 nothing coarser can show.
  float rem = 1.0, level = 0.0, cSum = 0.0;
  bool stale = false;
  float staleLevel = 0.0;
${perSlot((i) => `  if (rem > 0.0 && (u_on${i} == 1 || (u_on${i} == 2 && !stale))) {
    vec2 r = nestSlot(u_a${i}, u_b${i}, u_flow${i}, u_flowSize${i}, u_alpha${i}, u_lead${i},
                      gnomonicUV(lonLat, u_centre${i}, u_extent${i}) * 512.0 - 0.5, u_cell${i}, u_band${i}, u_maff${i});
    if (r.y > 0.0) {
      if (u_on${i} == 2) {
        stale = true; staleLevel = r.x;
      } else {
        float c = rem * r.y;
        level += c * r.x; cSum += c;
        rem *= 1.0 - r.y;
      }
    }
  }`)}
  if (cSum <= 0.0) {
    if (stale) level = staleLevel;
    else discard;
  }
  vec4 col = ramp(level);
  if (col.a <= 0.0) discard;
  fragColor = col;
}
`;
