# Nowcast Distortion — Design

Date: 2026-11-04. Amends the rain radar design (`2026-10-27-rain-radar-design.md`) §7.7, "Nowcast", and the nested-ranges design (`2026-11-03-nested-ranges-design.md`) where it restates the nowcast formula. Markers: **(user)** = the user decided; **(call)** = my call, open to the user's review; unmarked = follows from the existing code or data.

## 1. Intent

The further the playhead goes into the nowcast, the less the map looks like radar. Rain gets squeezed toward points, or smeared into streaks and mirrored copies. By +2–3 h it no longer looks like a real frame. The user noticed this and guessed the cause: motion vectors pointing in different directions squeeze the rain together.

**What the user wants (user):** a forecast frame should be **almost indistinguishable from a past frame**. Same sharpness, same colours, same kinds of shapes, just moved to where the rain will be. Users know a prediction is provisional and changes with new data, so the app does not need to show uncertainty. **Blurring or fading the forecast confuses users** and is out, including the fade that exists today.

### Why it happens

Today's nowcast is one straight jump back from each screen pixel along that pixel's motion vector (`interpolate.ts` `sampleForecast`, `nest.ts` `nestSlotSample`, the shader's `nestSlot`):

```
level(p, lead) = A(p − lead · V(p))
```

The local stretch of that mapping is `J = I − lead · ∇V`:

- Where the motion converges, `det J > 1`: a large source area lands on a small screen area, so rain is squeezed.
- Where it diverges or shears, `det J` falls. Once `lead · λ(∇V) ≥ 1`, the mapping **folds**: two screen pixels read the same source pixel, which produces mirrored and duplicated rain.

With a 3 h horizon (about 36 frame gaps) and flow cells 16 px apart, neighbouring cells only need to differ by about 0.45 px per gap to fold before +3 h. The block matcher (`flow.ts` `computeFlow`) finds whole-pixel offsets on the 4×-downsampled image, so each pair vector is quantised to 4 full-res px. Averaging 3 pairs and a 3×3 blur only partly smooth that out, so much of `∇V` is measurement noise rather than real convergence.

## 2. Goals, non-goals, anti-goals

### Goals
1. **No folding** at any lead up to `NOWCAST_MAX_MS` (3 h): no mirrored or duplicated rain.
2. **Shapes hold.** At +1 h to +3 h, storms keep roughly the shape they have in the newest frame and move with the overall wind, instead of being squeezed or stretched.
3. **Less noise in the motion vectors**, so the motion that does vary across the map reflects real differences in how rain is moving.
4. **No fade.** The forecast is drawn at full opacity on the map and in the tape graph **(user)**.
5. A measurable distortion number, so before/after can be compared on real frames and not only judged by eye.

### Non-goals
- **Blur or other "uncertainty" styling** that grows with lead **(user)**.
- Growth and decay. Rain is still carried forward unchanged (main spec §7.7).
- Changing which range's motion moves which nowcast (`NOWCAST_MOTION`, nested-ranges §4.4), the 3 h horizon, `FORECAST_PAIRS`, or the whole-frame 1/d² fill in `forecastFlow`.
- Changes to the server, ingest or API.
- Changing how past frames are interpolated, apart from the better vectors in §4.3, which they pick up automatically.

### Anti-goals (failure even if it technically works)
- The forecast looks softer or blurrier than a real frame. Each forecast pixel must still be **one** cell-bilinear (or display-cubic) read of the newest real frame, with no repeated resampling of the image.
- A visible jump in sharpness, position or opacity when playback crosses "now".
- The map, the tape and the rain hint disagree. They must keep using one shared formula (`nestSlotSample` ⇄ shader `nestSlot`).
- Scrubbing the forecast on a phone gets noticeably choppier.

## 3. Constraints and facts

- The nowcast formula exists in two places that must agree to float32 rounding: the CPU `nestSlotSample` (also used by `sampleForecast`, the tape's `buildHomeForecast` and the rain hint) and the shader's `nestSlot`. `parity.ts` `runParity` checks them against each other.
- The nowcast motion field is the 31×31 `forecastFlow` grid in **motion-grid px per ms**. A slot maps its own px to motion px with `motion: PixelAffine` (`u_maff`), which is not the identity for IDR504 → IDR503.
- **Texture units:** the fragment shader uses 4 slots × 3 samplers + the LUT = 13. WebGL2 only guarantees 16, so a fourth sampler per slot (17) is **not** allowed. Any extra per-slot field has to share a texture or be a uniform.
- GLSL ES 3.00 allows loops with a runtime bound, which the step loop in §4.1 needs.
- `buildHomeForecast` evaluates the nowcast at 361 lead times (30 s steps to 3 h) × the disc's native cells × up to 4 ranges, once per new frame/flow or location change. Per-sample cost multiplies straight into that.
- Flows are not persisted (`frameCache.ts` stores frames only), so a change to `computeFlow` needs no cache migration.
- The clock already labels forecast time ("+25 min forecast"), and the tape keeps its violet forecast tint (main spec §6, a user decision), so removing the fade does not leave the forecast unmarked.

## 4. The design

Three changes to the motion and the advection, one removal, and one measurement. The user chose options 1, 2 and 4 from the options discussed, and rejected blur (option 5) **(user)**.

### 4.1 Step-by-step backward advection (fixes folding) **(user: option 1)**

Replace the single jump with a backward path through the motion field, integrated in **motion-grid px**:

```
q = M(p)                       // slot px -> motion px (the slot's PixelAffine)
τ = lead
while τ > 0:
  h = min(STEP_MS, τ)
  q -= h · V(q, τ − h/2)       // V from §4.2, read at the current point
  τ -= h
s = M⁻¹(q)                     // back to slot px
level = A(s);  weight = min(edge weight at p, edge weight at s)
```

- Each forecast pixel still reads the newest frame **once**, at `s`, so there is no added blur.
- Paths that follow a smooth field can't cross, so the mapping doesn't fold as long as `STEP_MS · |∇V| ≪ 1`, which is easily met.
- **`STEP_MS` = 5 min (call)**, about one frame gap: at most 36 steps at +3 h. A smaller step changes almost nothing visible; the builder may tune it.
- Plain Euler steps, with velocity read at the current point and at the step's mid-time **(call)**. The builder may use a midpoint (RK2) step instead if it measurably helps, in both CPU and shader.
- Points outside the motion grid keep today's behaviour: `flowAt` clamps them to the edge cell.
- The edge weight is checked at `p` and at the final `s` only, as today.
- At lead 0 the path is empty and `s = p`, and with easing off (§4.2) a lead ≤ `STEP_MS` is exactly today's single jump. So nothing jumps at "now", and the first few minutes past it look as they do today.

### 4.2 Easing toward the large-scale motion (fixes squeezing) **(user: option 2)**

Small features in the motion field, like a swirl or a spot where vectors meet, don't last much beyond the first half hour or so. The overall steering flow does. So the motion used at forecast time `τ` blends the detailed field toward a smooth one:

```
V(q, τ) = lerp(V_local(q), V_large(q), r(τ))
r(τ)    = min(1, τ / RELAX_MS)
```

- `V_local` is today's `forecastFlow` output.
- **`V_large` (call):** for each cell, a Gaussian-weighted mean of the **measured** cells' vectors (the same per-cell means `forecastFlow` computes before its fill), with `σ = LARGE_SIGMA_CELLS` = 8 cells (about a quarter of the frame). With one storm system this approaches pure translation, which keeps shapes exactly. With two separate systems moving differently, each still moves with its own region's mean. Computed once in `forecastFlow`, next to `V_local`. With no measured cells both fields are zero, as today.
- **`RELAX_MS` = 60 min (call)**, tuned by eye on real storms. Before that the detailed motion still steers rain near "now". After it, rain slides as a near-rigid sheet, so deformation stops building up.
- **Passing it to the shader (call):** pack both fields into one **RGBA32F** flow texture (rg = local, ba = large) so the sampler count doesn't change (§3). Interpolation slots upload ba = rg (or zero) and ignore it. `RELAX_MS` goes in as a constant or uniform. The builder may choose another packing if it keeps 13 samplers.
- `FlowField` (or a dedicated forecast-flow type, builder's choice) carries the large-scale field alongside `data`. Memo keys that use the flow object's identity (`buildHomeForecast`) keep working, because both fields are built together.

### 4.3 Sub-pixel motion vectors (fixes noise) **(user: option 4)**

In `computeFlow`, after the integer search finds the best `(u, v)`, refine each axis by a parabola fit through the matching error at the best offset and its two neighbours:

```
δ = (S₋ − S₊) / (2 · (S₋ − 2·S₀ + S₊)),   clamped to [−0.5, 0.5]
```

- The search loop exits early (`sad < best`), so neighbour scores are incomplete. Compute the four neighbour SADs in full after the search, without the small-motion bias.
- Skip the refinement on an axis if the best offset is at the edge of the search window, or if the denominator is ≤ 0 (not a clean minimum).
- The 3×3 median and box blur stay, applied after refinement.
- This improves the interpolation between past frames too. That is wanted, not a side effect to avoid.

### 4.4 Remove the fade **(user)**

- Delete `FORECAST_MIN_OPACITY` and `forecastOpacity` (`interpolate.ts`) and the shader's `forecastOpacity`.
- `sampleNested` and the shader's main loop drop the opacity blend. Map opacity is 1 wherever there is data. The builder may simplify `sampleNested`'s return type if no other caller needs the opacity.
- The tape graph (`Tape.tsx`) draws forecast bars at full ramp alpha. The violet forecast tint and the "no data" shading past +3 h stay.

### 4.5 Distortion measurement

A pure function, e.g. `nowcastDeformation(v, leadMs) → { minDet, maxDet, maxStretch }`:

- It maps a grid of motion-grid points through the §4.1 path, takes the Jacobian of `p → s` by finite differences, and reports the smallest and largest `det J` and the largest ratio of principal stretches over points that land on rain-relevant cells (the builder may simply use the whole grid).
- `minDet ≤ 0` means a fold. `maxDet ≫ 1` means squeezing. `maxStretch ≫ 1` means streaks.
- Unit tests use it on synthetic fields (a converging field, and a shear field strong enough to fold the old formula before +3 h). The new path must give `minDet > 0` at every lead up to `NOWCAST_MAX_MS`. With easing on, `maxDet` and `maxStretch` must stop growing after `RELAX_MS` (allowing for the remaining variation of `V_large`).
- **For real frames (call):** expose it the way `runParity` is used (dev-only, from the console) so the user can print a before/after table at +30 min / +1 h / +2 h / +3 h for the current storm. Getting the "before" numbers means running it against the old single-jump formula too. A dev flag or a one-off script is fine; this is not a shipped feature.

### 4.6 Parity

`runParity` gains nowcast cases with multiple steps (several leads up to 3 h) and with a non-zero large-scale field, plus the existing half-scale motion case. Float32 drift adds up over steps, so differences at +3 h may be a little larger than today's. They must stay well under one level, and the edge weight must agree.

## 5. Acceptance

1. Unit tests: §4.3 recovers a known shift that isn't a multiple of 4 px (e.g. 18 px, 6 px) to within about 1 px. §4.1/§4.2 pass the §4.5 synthetic checks. With easing off (`V_large = V_local`), at `lead ≤ STEP_MS` the new formula matches the old within float rounding.
2. `runParity` passes in Chrome with the new cases.
3. `npm test` and `npx tsc --noEmit` are clean.
4. **By eye on a real storm (user's judgement):** at +1 h, +2 h and +3 h the map looks like a real radar frame, moved: no mirrored or duplicated rain, no rain shrinking to points, no visible fade. Map, tape and rain hint still agree at home.
5. Scrubbing through the forecast on the user's phone feels no choppier than before.

## 6. Spec text to update

- Main spec §7.7: replace "plain semi-Lagrangian backward advection with constant velocity, `level(p, lead) = newest(p − lead · V(p))`" with a pointer to §4.1–4.2 here, and delete "The forecast fades with lead time (opacity 1 → 0.55 at +3 h)".
- Main spec §6 (tape): delete "and the graph is drawn faded there". The violet tint stays.
- Nested-ranges spec: wherever it states the nowcast formula, point here.

## 7. Left to the builder

- `STEP_MS`, `RELAX_MS` and `LARGE_SIGMA_CELLS`, within the intent above. Tune on real storms; the defaults are my calls.
- Euler or midpoint steps (§4.1).
- How the large-scale field is carried in types and packed into the texture, within the 13-sampler budget.
- Whether `nowcastDeformation` samples the whole grid or only around rain.
- File placement: probably `flow.ts` for §4.2–4.3 and `nest.ts` / `interpolate.ts` for §4.1 and §4.5, following the existing split.
