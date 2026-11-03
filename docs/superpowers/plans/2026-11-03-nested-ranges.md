# Nested Radar Ranges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw all of the active radar's ranges at once, nested finest-first with narrow edge blends, and give the nowcast one motion field per region, so the map shows the finest data everywhere and the tape always agrees with it.

**Architecture:** A TypeScript master copy of the per-pixel nested sampler (`src/motion/nest.ts`) is ported line for line into GLSL, and one `RadarLayer` draws up to 4 slots with it in one pass. `FrameStore` learns which ranges the view needs, keeps the nowcast support range's newest frames loaded, schedules by priority tiers, and hands out nowcast pairs carrying the shared motion. `RadarView` builds the slots. The tape samples the same nested nowcast at home.

**Tech Stack:** TypeScript (strict), React 19, MapLibre GL 6 custom layer, WebGL2 / GLSL ES 3.00, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-nested-ranges-design.md` (amends `docs/superpowers/specs/2026-10-27-rain-radar-design.md`).

**Execution (user, 2026-11-03):** the session implements the tasks itself, in order, except **Task 2 and Task 5**. Each of those goes to one `general-purpose` Agent with `model: "opus"`, launched only after the previous task passes its checks. Its prompt says: read this plan and the spec, implement only Task N, follow Global Constraints (never `git add`/`git commit`; only the listed tests), and finish with `npm test` and `npx tsc --noEmit` clean. Its final report lists the files changed and any deviation from the task's Interfaces. Wait for the agent to finish, then re-run both checks yourself before starting the next task.

## Global Constraints

- **Git is the user's:** never `git add` or `git commit`. Each task ends with its changes left unstaged.
- **Lean tests (user):** only the tests listed per task. No per-task review agents. After each task the controller runs `npm test` and `npx tsc --noEmit`, both clean.
- **GPU/CPU parity:** the GLSL `nestSlot` is a line-for-line port of `nestSlotSample` in `src/motion/nest.ts`; `src/render/parity.ts` checks them against each other.
- **Ranges are ordered finest first** everywhere in new code (`RADARS[radar].products` is widest first; reverse it).
- **No fixed home (spec §10):** home-related code uses `RADARS[radar].tapeProduct` and `homePixel(store.geometry(tape))`. Never assume `IDR504` or the 64 km range.
- **Values from the spec:**
  - `BLEND_PX` in the range's own pixels: `IDR504: 20`, `IDR503: 12`, `IDR502: 12`, `IDR501: 0`, and the same by suffix for `IDR664/663/662/661`.
  - `NOWCAST_MOTION`: `IDR504 → IDR503`, `IDR503 → IDR503`, `IDR502 → IDR502`, `IDR501 → IDR501`, and the same by suffix for Stapylton.
  - `KEPT_TOLERANCE_MS = 300_000` (spec §4.3).
  - `OUTER_DECODED_CAP_MS = 7_200_000` for needed ranges other than the tape product (spec §5).
  - `DECODED_BUDGET_FRAMES = 180` decoded frames in total, about 46 MB (spec §5's ~48 MB).
  - `MAX_SLOTS = 4`.
  - Weight curve: smoothstep over the band; band 0 = hard edge.
  - Blend levels, not colours: `level = Σ cᵢ·Lᵢ`, `opacity = Σ cᵢ·opᵢ / Σ cᵢ` with `cᵢ = remᵢ·wᵢ` (spec §4.2).
- **"Now"** is the tape product's newest frame (spec §5.1).

## Review Focus

1. **Radar switch (Marburg → Stapylton) while zoomed out:** the old radar's slots vanish, the new radar's appear, and no textures leak. Pinned in Task 2 (`setSlots` replacing every product releases the old textures).
2. **Light/dark style switch:** MapLibre removes and re-adds the custom layer, and every slot must re-upload into the new context. Pinned in Task 2 (onRemove → onAdd → render re-creates textures).
3. **Scrubbing quickly into undecoded frames while zoomed out:** the map never blanks; the finest stale pair shows where nothing is fresh. Pinned in Task 1 (`sampleNested` stale fallback) and Task 6 (stale slots passed through).
4. **The motion source has a frame gap** (zero flows, no `valid`): the nowcast must not freeze. It falls back to the range's own motion. Pinned in Task 4.
5. **Start-up before the 128 km flows arrive:** the tape-range nowcast uses its own motion, then switches. Pinned in Task 4.

---

### Task 1: Nested sampler master copy (TypeScript)

**Files:**
- Modify: `shared/config.ts` (add `BLEND_PX`, `NOWCAST_MOTION`)
- Modify: `shared/gnomonic.ts` (add `PixelAffine`, `IDENTITY_AFFINE`, `pixelAffine`)
- Create: `src/motion/nest.ts`
- Test: `src/motion/nest.test.ts`, `shared/gnomonic.test.ts`

**Interfaces:**
- Produces:
  - `shared/config.ts`: `BLEND_PX: Record<ProductId, number>`, `NOWCAST_MOTION: Record<ProductId, ProductId>` (values in Global Constraints).
  - `shared/gnomonic.ts`: `type PixelAffine = { sx: number; ox: number; sy: number; oy: number }` (maps `from` px to `to` px: `x' = sx·x + ox`, `y' = sy·y + oy`, pixel-centre convention, pixel i at i). `IDENTITY_AFFINE: PixelAffine`. `pixelAffine(from: RadarGeometry, to: RadarGeometry): PixelAffine`: fit through two points (px (0,0) and (511,511) mapped via `uvToLonLat`/`lonLatToUV`). Throw if a third point (100, 400) is off by more than 0.05 px.
  - `src/motion/nest.ts`:
    - `KEPT_TOLERANCE_MS = 300_000`
    - `edgeDist(x: number, y: number): number`: px inside the 512 frame's edge, `min(x + 0.5, 511.5 − x, y + 0.5, 511.5 − y)`; negative outside.
    - `edgeWeight(d: number, band: number): number`: 0 for d < 0; band 0 → 1 for d ≥ 0; else `smoothstep(clamp(d / band, 0, 1))`.
    - `type NestSlot = { a: LevelField; b: LevelField; flow: FlowField; alpha: number; leadMs: number; cell: CellSize; band: number; motion: PixelAffine; fresh: boolean }`. `leadMs > 0` means nowcast: `a` is the newest frame, `flow` is the motion field in the *motion* grid's px/ms, and `motion` maps this slot's px to the motion grid's px.
    - `nestSlotSample(s: NestSlot, x: number, y: number): { level: number; weight: number }`
    - `sampleNested(slots: NestSlot[], ps: { x: number; y: number }[]): { level: number; opacity: number } | null`: slots finest first; `ps[i]` is the point in slot i's px. Null where nothing covers the point.
    - `isFresh(pair: { fromMs: number; toMs: number }, t: number): boolean`: `pair.fromMs − KEPT_TOLERANCE_MS ≤ t ≤ pair.toMs + KEPT_TOLERANCE_MS`.

The algorithm (the GLSL port in Task 2 must match it exactly; `bilinear` is the cell bilinear in `interpolate.ts`, so export it from there):

```ts
export function nestSlotSample(s: NestSlot, x: number, y: number) {
  let w = edgeWeight(edgeDist(x, y), s.band);
  if (w <= 0) return { level: 0, weight: 0 };
  if (s.leadMs > 0) {
    const [vx, vy] = flowAt(s.flow, s.motion.sx * x + s.motion.ox, s.motion.sy * y + s.motion.oy);
    const sx = x - (s.leadMs * vx) / s.motion.sx, sy = y - (s.leadMs * vy) / s.motion.sy;
    w = Math.min(w, edgeWeight(edgeDist(sx, sy), s.band));
    return { level: bilinear(s.a, sx, sy, s.cell), weight: w };
  }
  const [fx, fy] = flowAt(s.flow, x, y);
  const ax = x - s.alpha * fx, ay = y - s.alpha * fy, bx = x + (1 - s.alpha) * fx, by = y + (1 - s.alpha) * fy;
  w = Math.min(w, edgeWeight(edgeDist(ax, ay), s.band), edgeWeight(edgeDist(bx, by), s.band));
  const wa = bilinear(s.a, ax, ay, s.cell), wb = bilinear(s.b, bx, by, s.cell);
  return { level: Math.min((1 - s.alpha) * wa + s.alpha * wb, Math.max(wa, wb)), weight: w };
}

// sampleNested: rem = 1; for each fresh slot finest first: c = rem·w; level += c·L; opSum += c·forecastOpacity(leadMs);
// cSum += c; rem *= 1 − w; stop when rem <= 0. If cSum > 0 → { level, opacity: opSum / cSum }.
// Else: the first (finest) non-fresh slot with w > 0 → { level: L, opacity: forecastOpacity(leadMs) }. Else null.
```

- [ ] **Step 1: Write the failing tests** in `src/motion/nest.test.ts`:
  - `edgeWeight`: `(−1, 20) → 0`, `(0, 0) → 1`, `(0, 20) → 0`, `(10, 20) → 0.5`, `(25, 20) → 1`.
  - `nestSlotSample` nowcast with `IDENTITY_AFFINE`, band 0, matches `sampleForecast(a, v, lead, x, y, 2)` at a grid of interior points (some random field `a` and a uniform `v`).
  - Nowcast source outside the frame: uniform motion of +0.01 px/ms in x, lead 60 000 ms (600 px), point (100, 256) → `weight 0`.
  - Affine motion: `motion = { sx: 0.5, ox: 128, sy: 0.5, oy: 128 }`, uniform motion field 0.001 px/ms in x (motion px), lead 10 000 ms → reads `a` 20 fine px left of the point. Use a field with a single level-10 cell to check.
  - `sampleNested` with two slots (fine band 20, coarse band 0): interior point → the fine level; a point at `edgeDist` 10 inside the fine frame → `0.5·fine + 0.5·coarse`; fine `fresh: false` → the coarse level; both non-fresh → the fine level (stale fallback); a point outside both → `null`.
  - `isFresh({ fromMs: 0, toMs: 300_000 }, 600_000) === true`, `(…, 600_001) === false`.
- [ ] **Step 2:** In `shared/gnomonic.test.ts`, add a test: `pixelAffine(g504, g503)` (fixtures `shared/__fixtures__/IDR504.map`, `worker/__fixtures__/IDR503.map`) has `sx` and `sy` within 0.001 of 0.5005, and maps `homePixel(g504)` to within 0.05 px of `homePixel(g503)`'s centre.
- [ ] **Step 3: Run** `npx vitest run src/motion/nest.test.ts shared/gnomonic.test.ts`. Expected: FAIL (missing exports).
- [ ] **Step 4: Implement** the Interfaces above. Export `bilinear` from `src/motion/interpolate.ts` without changing it.
- [ ] **Step 5: Run** the same command. Expected: PASS. Then `npm test` and `npx tsc --noEmit` clean.

---

### Task 2: Multi-slot `RadarLayer` and shader

**Files:**
- Modify: `src/render/shaders.ts`, `src/render/radarLayer.ts`, `src/render/parity.ts`
- Test: `src/render/radarLayer.test.ts` (replace the crossfade tests)

**Interfaces:**
- Consumes: Task 1's `NestSlot` semantics, `BLEND_PX`, `PixelAffine`; `FramePair` from `src/data/frameStore.ts` gains `fromMs`, `toMs` and `motion` in Task 4, so declare the slot type here without depending on it.
- Produces:
  - `MAX_SLOTS = 4` (exported from `radarLayer.ts`).
  - `type LayerSlot = { product: ProductId; geometry: RadarGeometry; a: LevelField; b: LevelField; flow: FlowField; alpha: number; leadMs: number; motion: PixelAffine; fresh: boolean }`
  - `RadarLayer.setSlots(slots: LayerSlot[]): void`: finest first, at most `MAX_SLOTS` (throws above). Textures are kept per product. A product absent from the new list has its 3 textures released at the next `render` or `releaseTextures()`.
  - `RadarLayer.releaseTextures(): void` (all products).
  - Removed: `setGeometry`, `setPair`, `setCrossfade` and the owner/other hand-off.
- GLSL: `INTERP_GLSL` gains `edgeDist`, `edgeWeight` and `vec2 nestSlot(highp usampler2D a, highp usampler2D b, highp sampler2D fl, ivec2 fsize, float alpha, float lead, vec2 p, int k, float band, vec4 maff)` returning (level, weight). `maff = (sx, ox, sy, oy)`. It is a port of `nestSlotSample`; `levelAt` (with `u_smooth`) replaces `bilinear` on the map, as `sampleSlot` does now. `FRAGMENT_SHADER` is generated for `MAX_SLOTS` slots (a JS loop emitting per-slot uniforms and code). Per slot: `u_a{i} u_b{i} u_flow{i} u_flowSize{i} u_alpha{i} u_lead{i} u_cell{i} u_centre{i} u_extent{i} u_band{i} u_maff{i} u_on{i}`, where `u_on` is 0 = absent, 1 = fresh, 2 = stale. `main` implements `sampleNested`'s combination, then outputs `opacity · ramp(level)` premultiplied, discarding when null.
- Texture units: slot i uses 3i, 3i+1, 3i+2; the LUT uses 12. Absent slots bind slot 0's textures (samplers must be valid), with `u_on = 0`.
- Draw quad: the union of all slots' `mercQuad`s (reduce with the existing `unionQuad`).

- [ ] **Step 1: Write the failing tests** in `radarLayer.test.ts`, reusing the existing `mockGl`:
  - `setSlots` with 2 slots (`IDR504` fresh, `IDR503` stale), then render → uniforms `u_on0 = [1]`, `u_on1 = [2]`, `u_on2 = [0]`, `u_on3 = [0]`, `u_band0 = [20]`, `u_band1 = [12]`.
  - Replacing the slots with 2 Stapylton products and rendering → the Marburg products' 6 textures are deleted (live texture count = 6).
  - `onRemove` → 0 live textures; `onAdd` on a new mock GL, then render → 3 textures per slot created in the new context.
  - `setSlots` with 5 slots throws.
- [ ] **Step 2: Run** `npx vitest run src/render/radarLayer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the shader and layer changes. Update `parity.ts` so each case compares GLSL `nestSlot` (`u_smooth = 0`) with `nestSlotSample`, for interpolation alphas and nowcast leads. Add one nowcast case with `motion = { sx: 0.5, ox: 128, sy: 0.5, oy: 128 }` and band 20, and report `maxAbsDiff` for both level and weight.
- [ ] **Step 4: Keep the app compiling:** in `radarView.ts`, make `drawSlot` call `setSlots` with its one product (fresh), so a range change becomes a swap without a fade. This is a stopgap; Task 6 rewrites the file.
- [ ] **Step 5: Run** the test file again. Expected: PASS. Then `npm test` and `npx tsc --noEmit` clean.

---

### Task 3: `neededRanges`

**Files:**
- Create: `src/geo/neededRanges.ts`, `src/geo/neededRanges.test.ts`
- (`pickRange` stays until Task 6, which removes its last user.)

**Interfaces:**
- Consumes: `BLEND_PX`, `edgeDist` (Task 1), `lonLatToUV`, `Bounds`.
- Produces: `neededRanges(view: Bounds, geoms: RadarGeometry[]): ProductId[]`. `geoms` and the result are finest first. Sample the view on a 17 × 17 grid of lon/lat points, edges included. At each point, walk the ranges finest first, marking each range whose frame contains the point as needed. Stop at the first range whose full-weight interior contains it (`edgeDist ≥ BLEND_PX[p]`; for band 0, inside the frame).

- [ ] **Step 1: Write the failing tests**, using the map fixtures (`shared/__fixtures__/IDR501.map`, `IDR502.map`, `IDR504.map`, `worker/__fixtures__/IDR503.map`):
  - A 20 km box around `HOME` → `["IDR504"]`.
  - The 503 frame's `frameBounds` → `["IDR504", "IDR503", "IDR502"]`.
  - A box inside 502's interior but outside 503's frame (e.g. centred 200 km east of Marburg, 20 km wide) → `["IDR502"]`.
  - A 10 km box straddling the 504 frame's east edge → `["IDR504", "IDR503"]`.
- [ ] **Step 2: Run** `npx vitest run src/geo/neededRanges.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again. Expected: PASS.

---

### Task 4: FrameStore — "now", the support range, shared nowcast motion

**Files:**
- Modify: `src/data/frameStore.ts`
- Test: `src/data/frameStore.test.ts`

**Interfaces:**
- Consumes: `NOWCAST_MOTION`, `pixelAffine`, `IDENTITY_AFFINE` (Task 1).
- Produces:
  - `FramePair` gains `fromMs: number; toMs: number; motion: PixelAffine; motionFrom: ProductId`. For a past pair: `fromMs = am`, `toMs = bm`, `motion = IDENTITY_AFFINE`, `motionFrom = p`. For the nowcast: `fromMs = toMs = newest`, and `flow` is the forecast flow of `NOWCAST_MOTION[p]` with `motion = pixelAffine(geometry(p), geometry(source))` and `motionFrom = source`, **when** the source's forecast exists, is measured (built from at least one flow with a `valid` mask) and both geometries are loaded. Otherwise it is p's own forecast, with identity and `motionFrom = p`.
  - `FrameStore.tapeProducts(): ProductId[]`: finest first, `[tape, ...support]`, where support = `NOWCAST_MOTION[tape]` and the next coarser range than the tape, without duplicates and without the tape. Marburg → `["IDR504", "IDR503"]`; Stapylton → `["IDR663", "IDR662"]`. Empty when no radar.
  - Support products are created on refresh alongside the tape product, replacing `startProduct` (delete it; Task 6 removes its use in `radarView.ts`, so until then inline `RADARS[radar].products[2]` there). Introduce a per-product window `windowFor(ps)`: the tape product and any other product keep the existing window; a support product that nothing else asked for gets just its newest `FORECAST_PAIRS + 1` stamps. Its newest `FORECAST_PAIRS` pairs get flows. Task 5 extends `windowFor`.
  - `loadedWindow()`: `start` and `end` come from the tape product's `frames()` when it has any; otherwise from the current all-products logic.
  - The forecast state records `measured: boolean`.

- [ ] **Step 1: Write the failing tests** (extend the fakes with `validFlows?: boolean`, which makes the fake flow return a 31×31 field with `valid` all 1):
  - `loadedWindow().end` equals the tape product's newest when `IDR503`'s manifest runs 2 min later.
  - After start-up with nothing else requested, `IDR503` frames fetched = exactly its newest 4 stamps.
  - `tapeProducts()` is `["IDR504", "IDR503"]` for Marburg and `["IDR663", "IDR662"]` for Stapylton (newest Marburg stale by > `STALE_SWITCH_MS`).
  - With `validFlows`, after `start()`: `getPair("IDR504", newest + 10 min).motionFrom === "IDR503"`. With `gatedFlows` and only `IDR504`'s flows released: `"IDR504"` (Review Focus 5).
  - With default zero flows (no `valid`): `motionFrom === "IDR504"` (Review Focus 4).
  - A past pair has `fromMs`/`toMs` equal to its two stamps.
- [ ] **Step 2: Run** `npx vitest run src/data/frameStore.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Update existing tests that relied on `startProduct` (`IDR503` loaded in full at start-up).
- [ ] **Step 4: Run** again. Expected: PASS. Then `npm test` and `npx tsc --noEmit`.

---

### Task 5: FrameStore — needed ranges, per-range windows, priorities, budget

**Files:**
- Modify: `src/data/frameStore.ts`
- Test: `src/data/frameStore.test.ts`

**Interfaces:**
- Consumes: Task 4.
- Produces:
  - `FrameStore.setNeeded(ps: ProductId[]): void` replaces `ensureProduct` (delete it). Products not of the active radar are ignored. New ones are created and synced as `ensureProduct` did. Re-schedules.
  - `OUTER_DECODED_CAP_MS = 7_200_000`, `DECODED_BUDGET_FRAMES = 180` (exported).
  - **Windows per product** (extending Task 4's `windowFor`), all centred on the existing focus centre and clamped into [requested start, newest] like `window()`:
    - tape product: `DECODED_CAP_MS` (unchanged behaviour);
    - needed, non-tape: `OUTER_DECODED_CAP_MS`;
    - support-only: just its newest `FORECAST_PAIRS + 1` stamps (also kept when the product is needed);
    - other (inactive): no window, so no loads and no flows.
  - **Eviction:** active products evict outside their window, as now. Inactive products keep their decoded frames until the total decoded count exceeds `DECODED_BUDGET_FRAMES`, then lose them furthest from the centre first.
  - **Priority** for frame jobs and for `nextWantedFlow`, as a tier, then a key:
    - tier 0: the tape product's focus pair, i.e. its adjacent stamps around the centre, clamped to its own frames (the newest pair when the centre is past them);
    - tier 1: support products' newest stamps / newest pairs;
    - tier 2: other needed products' focus pairs, finest first;
    - tier 3: everything else in a window, nearest the centre first, finer range on ties.

- [ ] **Step 1: Write the failing tests:**
  - `setNeeded(["IDR502"])` → every `IDR502` frame fetched lies within `OUTER_DECODED_CAP_MS / 2` of the centre (live: the newest).
  - After `setNeeded(["IDR502"])`, settling, then `setNeeded([])` and `refresh()` → `IDR502`'s `fetchFrame` count doesn't grow, and `decoded("IDR502")` is unchanged (under budget).
  - Flow order with `gatedFlows`, Marburg, `setNeeded(["IDR502"])` before `start()`, released one at a time: the first flow is `IDR504`'s newest pair, the next 3 are `IDR503`'s newest 3 pairs, then `IDR502`'s newest pair.
- [ ] **Step 2: Run** `npx vitest run src/data/frameStore.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again. Expected: PASS. Then `npm test` and `npx tsc --noEmit`.

---

### Task 6: `RadarView` draws the nest

**Files:**
- Modify: `src/radar/radarView.ts` (rewrite), `src/radar/RadarScreen.tsx`
- Delete: `src/geo/pickRange.ts`, `src/geo/pickRange.test.ts`

**Interfaces:**
- Consumes: `neededRanges` (Task 3), `RadarLayer.setSlots`, `LayerSlot`, `MAX_SLOTS` (Task 2), `FrameStore.setNeeded`, the `FramePair` fields (Tasks 4–5), `isFresh` (Task 1).
- Produces: `new RadarView(map, store, addLayer)` (no `onProduct`), with `layer`, `time()`, `isLive()`, `setTime(t)`, `onStoreChange()`, `onMoveEnd()` and `dispose()`, same meanings as now. Delete `CROSSFADE_MS` and the slot/fade machinery.
  - **Needed ranges:** on `onStoreChange` and `onMoveEnd`, once every product of the active radar has a geometry, call `store.setNeeded(neededRanges(bounds, geometries finest first))`. Before that, don't call it; the store already loads the tape and support ranges.
  - **Draw:** one `RadarLayer`, created and added on the first draw. For each product of the active radar with a geometry, finest first, `store.getPair(p, t)`. When it's non-null, keep it as that product's last pair. Build a `LayerSlot` per product with a kept pair: `fresh = isFresh(kept, t)`, `leadMs = pair.forecastLeadMs ?? 0`. Pass at most `MAX_SLOTS` to `setSlots`. Kept pairs of products not in the active radar are dropped (radar switch).
- `RadarScreen.tsx`: drop the `onProduct` argument. Keep `view.layer` re-adding on `style.load`. Change the `moveend` comment to nesting.

- [ ] **Step 1: Implement** (no unit tests; `RadarView` has none today, and the live check in Task 8 covers it). Delete `pickRange.ts` and its test, and Task 4's inlined start-product stopgap.
- [ ] **Step 2: Run** `npm test` and `npx tsc --noEmit`. Expected: clean.

---

### Task 7: The tape and the rain hint use the nested nowcast

**Files:**
- Modify: `src/tape/homeSeries.ts`, `src/tape/Tape.tsx`, `src/radar/RadarScreen.tsx`
- Test: `src/tape/homeSeries.test.ts`

**Interfaces:**
- Consumes: `sampleNested`, `NestSlot` (Task 1), `pixelAffine` (Task 1), `FrameStore.tapeProducts()`, `getPair`, `geometry` (Task 4).
- Produces: `buildHomeForecast(store: Pick<FrameStore, "frames" | "getPair" | "geometry">, products: ProductId[]): HomeForecast | null`. `products` is finest first, `products[0]` the tape product; pass `store.tapeProducts()`. `fromMs` is the tape product's newest. For each step k, `t = fromMs + k · SERIES_STEP_MS`: the slots are `getPair(p, t)` for each product with a geometry (`fresh = pair !== null`). The value is the max of `sampleNested(...).level` over the tape product's home-disc cell centres (as `maxInDisc` enumerates them, `homePixel(geometry(tape))`), with each slot's point from `pixelAffine(geometry(tape), geometry(p))`. Null until the tape product's nowcast pair exists. Memoise per (tape newest, the tape nowcast pair's `flow` object, each support product's newest).
- `Tape.tsx` and `RadarScreen.tsx` call `buildHomeForecast(store, store.tapeProducts())`.

- [ ] **Step 1: Write the failing test** in `homeSeries.test.ts`: a fake store where the tape product (`IDR504`, fixture geometry) has a nowcast pair with an empty `a` and uniform motion carrying the home source point outside its frame at lead 60 min. The coarse product (`IDR503`, fixture geometry) has a pair whose `a` is level 6 everywhere. Then `values[120] === 6` and `values[0] === 0`.
- [ ] **Step 2: Run** `npx vitest run src/tape/homeSeries.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, and update the two call sites.
- [ ] **Step 4: Run** again. Expected: PASS. Then `npm test` and `npx tsc --noEmit`.

---

### Task 8: Spec upkeep and live check

**Files:**
- Modify: `docs/superpowers/specs/2026-10-27-rain-radar-design.md` (§7.5 and §7.7)

- [ ] **Step 1:** Replace main spec §7.5's body with a pointer to the nested-ranges design. In §7.7: the motion source (the 128 km range's inside its frame), the hint's source (nested nowcast at home), and the known limits (the "upwind edge empties" and "> 60 km storm missed" limits no longer apply inside the 128 km square).
- [ ] **Step 2: Live check** (`npm run dev`, Playwright at 390 × 844):
  - zoomed in at home: only `IDR504` and `IDR503` frames are fetched (network panel), and the 503 count is 4;
  - zoom out to the whole 512 km frame: four ranges drawn, no seam at the 64 km and 128 km edges in the past, and the prediction at +45 min shows rain crossing into the 64 km square without vanishing;
  - the tape's prediction at home matches the map at the home marker;
  - `performance.memory` / heap snapshot after zooming out and playing 2 h: decoded frames ≤ `DECODED_BUDGET_FRAMES`;
  - toggle the system colour scheme: the radar is redrawn;
  - run `runParity` from the dev console via `import("/src/render/parity.ts")` on two decoded frames: `maxAbsDiff` < 1e-3 for every case.
- [ ] **Step 3:** One light whole-project review (memory: wanted once, at the end).
