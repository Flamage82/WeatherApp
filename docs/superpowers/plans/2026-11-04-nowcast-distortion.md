# Nowcast Distortion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep forecast frames looking like real radar out to +3 h, with no folding, no squeezing to points, and no fade.

**Architecture:** `computeFlow` gains sub-pixel vectors. `forecastFlow` adds a large-scale field (`FlowField.large`) next to the detailed one. A new CPU master copy, `src/motion/advect.ts`, follows the motion backwards in 5-minute steps, easing from the detailed field to the large-scale one over the first hour. `nestSlotSample` and `sampleForecast` use it, and the shader's `nestSlot` ports it line for line, with both fields packed into one RGBA32F texture. The fade is removed everywhere. A deformation measure (`nowcastDeformation`) gives before/after numbers.

**Tech Stack:** TypeScript (strict), WebGL2 / GLSL ES 3.00, Vitest, MapLibre custom layer.

**Spec:** `docs/superpowers/specs/2026-11-04-nowcast-distortion-design.md` (amends `2026-10-27-rain-radar-design.md` §6/§7.7 and `2026-11-03-nested-ranges-design.md`).

**Execution (user, 2026-11-04):** native. A later session implements every task itself, in order, using superpowers:executing-plans, with no per-task agents. After Task 6, one fresh reviewer checks the whole change.

## Global Constraints

- **Lean tests (user):** only the tests listed per task. No per-task review agents. After each task the controller runs `npm test` and `npx tsc --noEmit`, both clean (baseline: 35 files, 285 tests passing).
- **GPU/CPU parity:** the GLSL `nestSlot`/`flowAt` are line-for-line ports of `nestSlotSample` (`src/motion/nest.ts`), `advectBack`/`nowcastVelocity` (`src/motion/advect.ts`) and `flowAt` (`src/motion/flow.ts`). Same step order, same clamps, same constants (interpolated from TS into the GLSL string as `NOWCAST_MAX_MS` is today).
- **Values from the spec:** `NOWCAST_STEP_MS = 300_000` (5 min); `RELAX_MS = 3_600_000` (60 min), `r(τ) = min(1, τ / RELAX_MS)` with τ clamped at ≥ 0; `LARGE_SIGMA_CELLS = 8`; `MAX_NOWCAST_STEPS = Math.ceil(NOWCAST_MAX_MS / NOWCAST_STEP_MS)` (= 36). Sub-pixel offset `δ = (S₋ − S₊) / (2·(S₋ − 2·S₀ + S₊))` clamped to [−0.5, 0.5].
- **Sampler budget:** the fragment shader stays at 4 slots × 3 samplers + LUT = 13. No new sampler per slot.
- **One read of the newest frame per pixel:** advection moves the *sample point* only. The image is never resampled repeatedly.
- **Commits:** one commit per task, only that task's files, message in the repo's style plus the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.

## Review Focus

1. **Past-frame (interpolation) slots and flows without `large`** (`computeFlow` output, `ZERO_FLOW`, worker zero grids): the upload must still fill all four channels, and the interpolation path must read only `.xy`. Pinned in Task 4 (`packFlow` test).
2. **Lead at or past `NOWCAST_MAX_MS`:** both copies cap at `MAX_NOWCAST_STEPS`, so the CPU and the GPU agree and the loop is bounded. Pinned in Task 3.
3. **Crossing "now":** at small leads the new path matches the old jump, so nothing visibly jumps. Pinned in Task 3.
4. **The IDR504 → IDR503 motion affine across several steps:** the path must integrate in motion px and map back. Pinned in Task 3.
5. **Dry weather (no measured motion):** `forecastFlow` gives zero `data` *and* zero `large`, so rain is drawn stationary, not moved by garbage. Pinned in Task 2.

---

### Task 1: Sub-pixel motion vectors

**Files:**
- Modify: `src/motion/flow.ts` (`computeFlow`, lines 42–124)
- Test: `src/motion/flow.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `computeFlow(a, b): FlowField`, same signature. Vectors are now fractional (full-res px, still ×`DS`).

- [ ] **Step 1: Write the failing test** in the `computeFlow` describe block. Move the `patch` helper from the `forecastFlow` block up to file scope so both blocks use it:

```ts
it("recovers a shift that isn't a multiple of 4 px to within 1 px (sub-pixel)", () => {
  for (const [dx, dy] of [[18, 6], [6, 18]] as const) {
    const [vx, vy] = flowAt(computeFlow(patch(0, 0), patch(dx, dy)), 225, 225);
    expect(Math.abs(vx - dx)).toBeLessThan(1);
    expect(Math.abs(vy - dy)).toBeLessThan(1);
  }
});
```

- [ ] **Step 2: Run** `npx vitest run src/motion/flow.test.ts`. Expected: the new test FAILS, because integer matching on the 128 grid gives 16 or 20 for 18.

- [ ] **Step 3: Implement.** After the search loop for each valid cell, compute the four neighbour SADs **in full** (no early exit, no small-motion bias) at `(bu±1, bv)` and `(bu, bv±1)`, using the same out-of-bounds-reads-0 rule. Factor a `blockSad(A, B, ox, oy, u, v): number` helper out of the loop body. Per axis: skip if `|b| === SEARCH` or the denominator is ≤ 0; otherwise add `δ` (formula and clamp in Global Constraints). Store `vx[k] = bu + δx`, `vy[k] = bv + δy`. Fill, median, blur and `× DS` are unchanged.

- [ ] **Step 4: Run** `npx vitest run src/motion/flow.test.ts`. Expected: all PASS, including the existing `(16, 8)`, identical-frames, empty and "runs fast" (< 500 ms) tests.

- [ ] **Step 5: Run** `npm test` and `npx tsc --noEmit`. Expected: clean. Some interpolation tests use `computeFlow` output; if one fails, check that it relied on integer vectors before loosening anything.

- [ ] **Step 6: Commit** `src/motion/flow.ts src/motion/flow.test.ts`, message "Nowcast: sub-pixel motion vectors".

---

### Task 2: Large-scale motion field

**Files:**
- Modify: `src/motion/flow.ts` (`FlowField`, `flowAt`, `forecastFlow`)
- Test: `src/motion/flow.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `FlowField = { gw; gh; data: Float32Array; valid?: Uint8Array; large?: Float32Array }`. `large` has the same layout as `data` (gw·gh·2). Only `forecastFlow` sets it; absent means "same as `data`".
  - `flowAt(f: FlowField, x: number, y: number, field: Float32Array = f.data): [number, number]`. Same mapping, reading `field`.
  - `export const LARGE_SIGMA_CELLS = 8`.
  - `forecastFlow(flows, gapsMs): FlowField`, now always returning `large`.

- [ ] **Step 1: Write the failing tests** in the `forecastFlow` block. Add a helper `cellFlow(fn: (cx, cy) => [number, number]): FlowField`: a 31×31 field, every cell `valid`, cell centre `cx = 16i + 16`, `cy = 16j + 16`, data = `fn(cx, cy)`.

```ts
it("gives a large-scale field equal to a uniform motion", () => {
  const v = forecastFlow([cellFlow(() => [30, -12])], [300_000]);
  expect(flowAt(v, 256, 256, v.large)[0]).toBeCloseTo(30 / 300_000, 12);
  expect(flowAt(v, 40, 470, v.large)[1]).toBeCloseTo(-12 / 300_000, 12);
});

it("smooths a short wave out of the large-scale field", () => {
  const a = 3e-6;
  const v = forecastFlow([cellFlow((cx) => [0, a * Math.sin((2 * Math.PI * cx) / 64)])], [1]);
  // cx = 272 is a wave crest (sin(8.5π) = 1): the detailed field keeps it, the large-scale one doesn't.
  expect(flowAt(v, 272, 256)[1]).toBeCloseTo(a, 9);
  expect(Math.abs(flowAt(v, 272, 256, v.large)[1])).toBeLessThan(0.1 * a);
});

it("gives zero data and zero large-scale motion when nothing was measured", () => {
  const dry: FlowField = { gw: 31, gh: 31, data: new Float32Array(31 * 31 * 2), valid: new Uint8Array(31 * 31) };
  const v = forecastFlow([dry], [300_000]);
  expect(v.data.every((x) => x === 0)).toBe(true);
  expect(v.large?.every((x) => x === 0)).toBe(true);
});
```

- [ ] **Step 2: Run** `npx vitest run src/motion/flow.test.ts`. Expected: FAIL (`v.large` undefined).

- [ ] **Step 3: Implement.** In `forecastFlow`, after the per-cell means of the measured (`known`) cells are in `out` and before the 1/d² fill overwrites the rest, compute for every cell `k`: `large[k] = Σ_{m∈known} g(k,m)·out[m] / Σ g`, with `g = exp(−d²/(2·LARGE_SIGMA_CELLS²))` and `d` in cells. Precompute `g` as a (2·31−1)² table indexed by `(di, dj)`. With no known cells, `large` is all zeros. Then run the existing fill on `data` as before. Update the `forecastFlow` doc comment to describe `large`.

- [ ] **Step 4: Run** `npx vitest run src/motion/flow.test.ts`, then `npm test` and `npx tsc --noEmit`. Expected: all PASS / clean.

- [ ] **Step 5: Commit** `src/motion/flow.ts src/motion/flow.test.ts`, message "Nowcast: large-scale motion field".

---

### Task 3: Step-by-step advection with easing (CPU master copy) and the deformation measure

**Files:**
- Create: `src/motion/advect.ts`
- Create: `src/motion/advect.test.ts`
- Modify: `src/motion/nest.ts` (`nestSlotSample` nowcast branch, lines 51–56)
- Modify: `src/motion/interpolate.ts` (`sampleForecast`, lines 45–56, and its doc comment)

**Interfaces:**
- Consumes: `flowAt(f, x, y, field)`, `FlowField.large` (Task 2); `NOWCAST_MAX_MS` (`shared/config`).
- Produces (all in `src/motion/advect.ts`):
  - `export const NOWCAST_STEP_MS = 300_000`, `RELAX_MS = 3_600_000`, `MAX_NOWCAST_STEPS = Math.ceil(NOWCAST_MAX_MS / NOWCAST_STEP_MS)`.
  - `nowcastVelocity(v: FlowField, x: number, y: number, tauMs: number): [number, number]` = `lerp(flowAt(v, x, y), flowAt(v, x, y, v.large ?? v.data), min(1, max(0, tauMs / RELAX_MS)))`.
  - `advectBack(v: FlowField, qx: number, qy: number, leadMs: number): [number, number]`, in motion px.
  - `nowcastDeformation(v: FlowField, leadMs: number, opts?: { singleJump?: boolean; from?: number; to?: number; step?: number }): { minDet: number; maxDet: number; maxStretch: number }`. Defaults: `from 16`, `to 496`, `step 16` (motion px).

`advectBack` fixes the step order the shader must copy, so here it is:

```ts
let tau = leadMs;
for (let k = 0; k < MAX_NOWCAST_STEPS && tau > 0; k++) {
  const h = Math.min(NOWCAST_STEP_MS, tau);
  const [vx, vy] = nowcastVelocity(v, qx, qy, tau - h / 2);
  qx -= h * vx; qy -= h * vy; tau -= h;
}
return [qx, qy];
```

`nowcastDeformation`: for each grid point p in `[from, to]²` at `step`, map with `advectBack` (or, with `singleJump`, the old `p − lead·flowAt(v, p)` on `data` only, for "before" numbers). Take central differences with ±1 px for the 2×2 Jacobian J of p → s. Report `det J` min/max and `σ₁/σ₂`, where `σ₁,₂² = (‖J‖F² ± √(‖J‖F⁴ − 4·det²)) / 2`. Use `Infinity` when σ₂ = 0.

- [ ] **Step 1: Write the failing tests** in `src/motion/advect.test.ts`. Reuse the `cellFlow` shape from Task 2 (copy it locally; `forecastFlow([cellFlow(fn)], [1])` turns px values into px/ms unchanged).

```ts
const H = [1_800_000, 3_600_000, 7_200_000, 10_800_000];
const mid = { from: 192, to: 320 };

it("the old single jump folds a diverging field before +3 h; the stepped path never does", () => {
  const c = 1 / 7_200_000; // single-jump fold at +2 h
  const v = forecastFlow([cellFlow((cx) => [c * (cx - 256), 0])], [1]);
  expect(nowcastDeformation(v, 10_800_000, { singleJump: true, ...mid }).minDet).toBeLessThan(0);
  for (const lead of H) expect(nowcastDeformation(v, lead, mid).minDet).toBeGreaterThan(0);
});

it("easing stops a shear wave's stretching from growing after RELAX_MS", () => {
  const v = forecastFlow([cellFlow((cx) => [0, 3e-6 * Math.sin((2 * Math.PI * cx) / 64)])], [1]);
  const noEase = { ...v, large: v.data };
  const ratio = (f: FlowField) => nowcastDeformation(f, 10_800_000, mid).maxStretch / nowcastDeformation(f, 3_600_000, mid).maxStretch;
  expect(ratio(v)).toBeLessThan(1.25);
  expect(ratio(noEase)).toBeGreaterThan(1.5);
});

it("matches the old single jump at a lead within one step, with easing off", () => {
  const v = forecastFlow([cellFlow((cx, cy) => [1e-5 * Math.sin(cx / 50), 1e-5 * Math.cos(cy / 70)])], [1]);
  const off = { ...v, large: v.data };
  for (const [x, y] of [[100.3, 200.7], [256, 256], [410.5, 90.25]] as const) {
    const [vx, vy] = flowAt(off, x, y);
    const [sx, sy] = advectBack(off, x, y, 240_000);
    expect(sx).toBeCloseTo(x - 240_000 * vx, 9);
    expect(sy).toBeCloseTo(y - 240_000 * vy, 9);
  }
});

it("caps at MAX_NOWCAST_STEPS: a lead past NOWCAST_MAX_MS goes no further", () => {
  const v: FlowField = { gw: 1, gh: 1, data: new Float32Array([1e-5, 0]) };
  expect(advectBack(v, 256, 256, NOWCAST_MAX_MS + 600_000)).toEqual(advectBack(v, 256, 256, NOWCAST_MAX_MS));
});
```

Add to `src/motion/nest.test.ts` (`nestSlotSample` block):

```ts
it("integrates through the motion affine across several steps", () => {
  const a = field((cx, cy) => (cx === 90 && cy === 50 ? 10 : 0)); // cell centre at pixel (180.5, 100.5)
  const s = slot({ a, flow: uniformFlow(1 / 60_000, 0), leadMs: 1_200_000, motion: { sx: 0.5, ox: 128, sy: 0.5, oy: 128 } });
  // 20 min × 1/60_000 motion px/ms = 20 motion px = 40 slot px
  expect(nestSlotSample(s, 220.5, 100.5).level).toBeCloseTo(10, 3);
  expect(nestSlotSample(s, 180.5, 100.5).level).toBe(0);
});
```

- [ ] **Step 2: Run** `npx vitest run src/motion/advect.test.ts src/motion/nest.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/motion/advect.ts`** per the Interfaces block. The doc comment states the formula as THE nowcast formula, and that the shader's `nestSlot` reproduces it.

- [ ] **Step 4: Rewire the callers.** In `nestSlotSample`'s nowcast branch: `q = (m.sx·x + m.ox, m.sy·y + m.oy)`, `[qx, qy] = advectBack(s.flow, q…, s.leadMs)`, `s = ((qx − m.ox)/m.sx, (qy − m.oy)/m.sy)`. The edge weight stays at `p` and the final `s`. `sampleForecast(a, v, leadMs, x, y, cell)` becomes `bilinear(a, ...advectBack(v, x, y, leadMs), cell)`. Update both doc comments, which currently say "constant velocity".

- [ ] **Step 5: Run** `npm test` and `npx tsc --noEmit`. Expected: clean, including the existing "nowcast with identity motion matches sampleForecast" (still exact `toBe`) and `homeSeries` tests.

- [ ] **Step 6: Commit** `src/motion/advect.ts src/motion/advect.test.ts src/motion/nest.ts src/motion/nest.test.ts src/motion/interpolate.ts`, message "Nowcast: step-by-step advection easing to the large-scale motion".

---

### Task 4: Shader port, packed flow texture, parity

**Files:**
- Modify: `src/render/radarLayer.ts` (`uploadFlow`, lines 106–111; add `packFlow`)
- Modify: `src/render/shaders.ts` (`flowAt`, `nestSlot`; header comment)
- Modify: `src/render/parity.ts` (doc comment; cases)
- Test: `src/render/radarLayer.test.ts`

**Interfaces:**
- Consumes: `NOWCAST_STEP_MS`, `RELAX_MS`, `MAX_NOWCAST_STEPS` (Task 3); `FlowField.large` (Task 2).
- Produces: `export function packFlow(f: FlowField): Float32Array`, RGBA per cell, `rg = data`, `ba = large ?? data`. `uploadFlow` uploads it as `RGBA32F` / `RGBA` / `FLOAT`. GLSL `vec4 flowAt(sampler, size, p)` returns `(local.xy, large.xy)`.

- [ ] **Step 1: Write the failing test** in `src/render/radarLayer.test.ts`:

```ts
it("packFlow puts the detailed field in rg and the large-scale one in ba, defaulting to the detailed", () => {
  const data = new Float32Array([1, 2, 3, 4]);
  expect(Array.from(packFlow({ gw: 2, gh: 1, data }))).toEqual([1, 2, 1, 2, 3, 4, 3, 4]);
  expect(Array.from(packFlow({ gw: 2, gh: 1, data, large: new Float32Array([5, 6, 7, 8]) }))).toEqual([1, 2, 5, 6, 3, 4, 7, 8]);
});
```

- [ ] **Step 2: Run** `npx vitest run src/render/radarLayer.test.ts`. Expected: FAIL (`packFlow` not exported).

- [ ] **Step 3: Implement `packFlow` and the RGBA32F upload.**

- [ ] **Step 4: Port to GLSL.** `flowAt` interpolates all four channels and returns `vec4`. The interpolation branch of `nestSlot` uses `flowAt(...).xy`. The nowcast branch becomes `q = vec2(maff.x*p.x + maff.y, maff.z*p.y + maff.w)`, then a `for (int k = 0; k < MAX_NOWCAST_STEPS; k++) { if (tau <= 0.0) break; … }` loop that copies `advectBack` exactly (with `r = clamp((tau − 0.5*h) / RELAX_MS, 0.0, 1.0)` and `v = mix(f.xy, f.zw, r)`), then `s = vec2((q.x − maff.y)/maff.x, (q.y − maff.w)/maff.z)`. Interpolate the three constants from TS (`.toFixed(1)` for the floats; an `int` literal for the step count). Update the `INTERP_GLSL` header comment to list `advect.ts` among the ported functions.

- [ ] **Step 5: Extend `runParity`'s cases.** Change the `leads` default from `[]` to `[300_000, 1_800_000, 3_600_000, 10_800_000]`. The flow passed in should carry `large` (the controller passes a real nowcast flow). Update the doc comment.

- [ ] **Step 6: Run** `npm test` and `npx tsc --noEmit`. Expected: clean.

- [ ] **Step 7: Live parity check (controller).** Start `npm run dev`, open the app in Chrome, wait for frames, then in the console:

```js
const { runParity } = await import("/src/render/parity.ts");
const s = __radar.store, p = "IDR503", t = s.frames(p).at(-1);
const fc = s.getPair(p, t + 60_000);
console.table(runParity(fc.a, fc.a, fc.flow, fc.cell, [0, 1], 256, undefined, 12)
  .map((r) => ({ alpha: r.alpha, lead: r.leadMs, aff: r.motion.sx, dLevel: r.maxAbsDiff.level, dWeight: r.maxAbsDiff.weight })));
```

Expected: no shader compile error. Every row has `dLevel < 0.05` and `dWeight < 0.001`. Also check the map visually: past frames look unchanged, and the forecast moves and shows no mirrored rain.

- [ ] **Step 8: Commit** `src/render/radarLayer.ts src/render/radarLayer.test.ts src/render/shaders.ts src/render/parity.ts`, message "Nowcast: shader port of stepped advection".

---

### Task 5: Remove the fade

**Files:**
- Modify: `src/motion/interpolate.ts` (delete `FORECAST_MIN_OPACITY`, `forecastOpacity`)
- Modify: `src/motion/nest.ts` (`sampleNested`)
- Modify: `src/render/shaders.ts` (delete GLSL `forecastOpacity`; main loop)
- Modify: `src/tape/Tape.tsx` (line 187, import on line 6)
- Modify: `src/tape/homeSeries.ts` (line 84)
- Test: `src/motion/nest.test.ts`

**Interfaces:**
- Produces: `sampleNested(slots, ps): number | null`, the blended level, or null where nothing covers the point. Same weighting and stale fallback; the opacity sum is gone.

- [ ] **Step 1: Update the `sampleNested` tests** to the new return type: `toEqual({ level: 8, opacity: 1 })` → `toBe(8)`, and `!.level` → the value itself.

- [ ] **Step 2: Run** `npx vitest run src/motion/nest.test.ts`. Expected: FAIL (still returns an object).

- [ ] **Step 3: Implement.** Make `sampleNested` return the level. `homeSeries` uses `sampleNested(...) ?? 0`. In the shader's `main`, drop `opSum`/`staleOp`/`op`, keep `cSum` for "has data", and set `vec4 col = ramp(level)`. In `Tape.tsx`, draw forecast bars at alpha `a / 255`, keeping the violet tint and the shading past +3 h. Delete the now-unused exports and imports, and update the comments that mention fading (`nest.ts` `sampleNested` doc, `shaders.ts` header, the `FRAGMENT_SHADER` doc "drawn faded with lead time").

- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit`. Expected: clean, with nothing importing `forecastOpacity` (tsc catches it).

- [ ] **Step 5: Commit** the five source files and `src/motion/nest.test.ts`, message "Nowcast: drop the fade".

---

### Task 6: Dev deformation hook and spec text

**Files:**
- Modify: `src/radar/RadarScreen.tsx` (line 219, the `import.meta.env.DEV` hook)
- Modify: `docs/superpowers/specs/2026-10-27-rain-radar-design.md` (§6 line 130, §7.7 lines 184–186)
- Modify: `docs/superpowers/specs/2026-11-03-nested-ranges-design.md` (wherever it states the nowcast formula `newest(p − lead · V(p))`)

**Interfaces:**
- Consumes: `nowcastDeformation` (Task 3), `runParity` (Task 4).

- [ ] **Step 1: Extend the dev hook** to `__radar: { map, store, view, nowcastDeformation, runParity }`. A static import is fine; tree-shaking is not a concern for a personal app, but keep it inside the DEV branch.

- [ ] **Step 2: Update the spec text** per spec §6: point §7.7's advection sentence at `2026-11-04-nowcast-distortion-design.md` §4.1–4.2; delete the fade sentence and "and the graph is drawn faded there"; point the nested-ranges spec's formula at the new design.

- [ ] **Step 3: Run** `npm test` and `npx tsc --noEmit`. Expected: clean.

- [ ] **Step 4: Live before/after (controller, with the user).** With the dev server running, in the console:

```js
const s = __radar.store, t = s.frames("IDR503").at(-1), v = s.getPair("IDR503", t + 60_000).flow;
console.table([1_800_000, 3_600_000, 7_200_000, 10_800_000].flatMap((lead) => [false, true].map((singleJump) =>
  ({ lead: lead / 60_000 + " min", old: singleJump, ...__radar.nowcastDeformation(v, lead, { singleJump }) }))));
```

Expected: new rows have `minDet > 0` at every lead. Show the table to the user, together with the map at +1 h / +2 h / +3 h on a day with rain (spec §5 items 4–5).

- [ ] **Step 5: Commit** `src/radar/RadarScreen.tsx` and the two spec files, message "Nowcast: dev deformation hook; spec text".
