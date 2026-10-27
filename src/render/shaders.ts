/**
 * GLSL ES 3.00 sources for the radar layer.
 *
 * INTERP_GLSL is a line-for-line port of `src/motion/interpolate.ts` `sampleInterpolated` and
 * `src/motion/flow.ts` `flowAt`. Both bilinear lookups are done by hand with `texelFetch`, not
 * hardware filtering:
 *  - level textures (R8UI): out-of-bounds taps read 0 exactly, which WebGL2 can't express with
 *    wrap modes (no clamp-to-border), and the tap positions match the CPU (value at integer coords);
 *  - flow texture (RG32F): float textures aren't filterable without OES_texture_float_linear, and
 *    the CPU's grid mapping (cell i centred at (i+1)*512/(gw+1), clamped to the edge cell) is not
 *    the texture-space mapping LINEAR filtering would use anyway.
 * So the GPU result equals the CPU result up to float32 rounding. The same chunk is used by the
 * parity check in `parity.ts`.
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

// flowAt: cell (i, j) centred at full-res ((i+1)*512/(gw+1), (j+1)*512/(gh+1)); clamped to edge.
vec2 flowAt(highp sampler2D t, ivec2 size, vec2 p) {
  vec2 gs = vec2(size);
  vec2 g = clamp(p * (gs + 1.0) / 512.0 - 1.0, vec2(0.0), gs - 1.0);
  vec2 g0 = floor(g);
  vec2 f = g - g0;
  ivec2 i0 = ivec2(g0);
  ivec2 i1 = min(i0 + 1, size - 1);
  vec2 v00 = texelFetch(t, i0, 0).rg;
  vec2 v10 = texelFetch(t, ivec2(i1.x, i0.y), 0).rg;
  vec2 v01 = texelFetch(t, ivec2(i0.x, i1.y), 0).rg;
  vec2 v11 = texelFetch(t, i1, 0).rg;
  return (v00 * (1.0 - f.x) + v10 * f.x) * (1.0 - f.y) + (v01 * (1.0 - f.x) + v11 * f.x) * f.y;
}

// THE formula (see interpolate.ts):
//   F = flowAt(p); wa = A(p - alpha*F); wb = B(p + (1-alpha)*F)
//   result = min((1-alpha)*wa + alpha*wb, max(wa, wb))
float sampleInterpolated(highp usampler2D a, highp usampler2D b, highp sampler2D fl, ivec2 fsize,
                         float alpha, vec2 p, int k) {
  vec2 F = flowAt(fl, fsize, p);
  float wa = bilinearLevel(a, p - alpha * F, k);
  float wb = bilinearLevel(b, p + (1.0 - alpha) * F, k);
  return min((1.0 - alpha) * wa + alpha * wb, max(wa, wb));
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

/**
 * Two "slots" so one pass can crossfade between two ranges (slot 1 is skipped while u_mix == 0).
 * Per slot: gnomonic tangent point (radians), image extent in tangent-plane units, the A/B level
 * textures, the A->B flow texture and the blend position alpha.
 */
export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;

${INTERP_GLSL}

const float PI = 3.141592653589793;

uniform highp usampler2D u_a0, u_b0, u_a1, u_b1;
uniform highp sampler2D u_flow0, u_flow1;
uniform ivec2 u_flowSize0, u_flowSize1;
uniform float u_alpha0, u_alpha1;
uniform int u_cell0, u_cell1;        // native cell size k (CELL_SIZE[product])
uniform vec2 u_centre0, u_centre1;   // (lat0, lon0) radians
uniform vec4 u_extent0, u_extent1;   // (xMin, xMax, yMin, yMax)
uniform float u_mix;                 // 0 = all slot 0, 1 = all slot 1
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

bool inside(vec2 uv) { return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0; }

// Premultiplied ramp colour of a level; LUT entry i holds level i/255*15.
vec4 ramp(float level) {
  vec4 c = texture(u_lut, vec2((clamp(level, 0.0, 15.0) * 17.0 + 0.5) / 256.0, 0.5));
  return vec4(c.rgb * c.a, c.a);
}

void main() {
  vec2 lonLat = vec2(v_merc.x * 2.0 * PI - PI, atan(sinh(PI * (1.0 - 2.0 * v_merc.y))));
  vec4 col = vec4(0.0);
  bool hit = false;
  if (u_mix < 1.0) {
    vec2 uv = gnomonicUV(lonLat, u_centre0, u_extent0);
    if (inside(uv)) {
      hit = true;
      float l = sampleInterpolated(u_a0, u_b0, u_flow0, u_flowSize0, u_alpha0, uv * 512.0 - 0.5, u_cell0);
      col += (1.0 - u_mix) * ramp(l);
    }
  }
  if (u_mix > 0.0) {
    vec2 uv = gnomonicUV(lonLat, u_centre1, u_extent1);
    if (inside(uv)) {
      hit = true;
      float l = sampleInterpolated(u_a1, u_b1, u_flow1, u_flowSize1, u_alpha1, uv * 512.0 - 0.5, u_cell1);
      col += u_mix * ramp(l);
    }
  }
  if (!hit || col.a <= 0.0) discard;
  fragColor = col;
}
`;
