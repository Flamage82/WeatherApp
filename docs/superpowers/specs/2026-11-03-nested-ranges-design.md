# Nested Radar Ranges — Design

Date: 2026-11-03. Amends the rain radar design (`2026-10-27-rain-radar-design.md`). It replaces that spec's §7.5, "Picking a range as you zoom", and changes §7.7, "Nowcast". Markers: **(user)** = the user decided; **(call)** = my call, open to the user's review; unmarked = follows from the existing code or data.

## 1. Intent

The map now shows **one** range of the active radar at a time: the sharpest range that covers the whole visible map (`pickRange`), crossfading when that changes. This has two problems:

1. **Detail is wasted.** Zoomed out a little past the 64 km frame, the whole map drops to 128 km detail, including around home, where 64 km data exists.
2. **The map and the tape disagree.** The tape and the rain hint always use the 64 km range (`IDR504` / `IDR663`), and each range estimates storm motion separately. In the nowcast, a storm can miss home on the 128 km map while the tape shows it hitting. The user saw exactly this, and it is what prompted this change.

**The change (user):** draw all of the active radar's ranges at once, nested. Each spot on the map shows the finest range that has data there: 64 km in its square, 128 km around it, then 256 km, then 512 km. Ranges blend into each other at their edges.

**And for the nowcast (user, after a test on archived storms, §9):** one shared motion field instead of one per range. Inside the 128 km square, home included, every range's prediction is moved by the 128 km range's motion. Where that motion pulls in rain from outside a finer range's square, the coarser range supplies it. The tape and the rain hint use the same prediction, so they always match the map.

## 2. Goals, non-goals, anti-goals

### Goals
1. Every spot on the map shows the finest range available there, whatever the zoom **(user)**.
2. No visible seam where ranges meet. A **narrow blend** at each finer range's edge **(user chose option B of three mockups: hard edge, narrow ~5 km, wide ~20 km)**.
3. Zoomed in around home, the app is as fast and light as now. **The zoomed-in case matters most (user):** the user mostly uses a phone and opens the app either zoomed in or zoomed out, but zoomed in is more important.
4. The map and the tape agree at home, during playback and in the nowcast **(user)**.
5. The nowcast gets more accurate, especially late in the hour: rain coming from outside the 64 km square must arrive (§9 measured this as the biggest accuracy gain available).

### Non-goals
- **Mixing radars.** Marburg and Mt Stapylton never blend; the backup-radar switch (§7.6 of the main spec) stays as it is. Stapylton's four ranges nest in the same way **(call)**.
- **Shared motion for the past.** Between real frames, each range keeps its own per-pair flow (main spec §7.4). Over 5 minutes the displacements are small, and the fine flow keeps 64 km detail crisp as it moves.
- **A perfectly seamless nowcast at the outer edges.** Beyond the 128 km square, the 256 km and 512 km ranges use their own motion. In the blend band at those edges, a storm may look slightly doubled or smeared late in the hour. **Accepted (user, for the blend band generally).**
- Growth and decay in the nowcast. It still moves rain without changing it (main spec §7.7).
- Changes to the server, the ingest or the API. Every range is already fetched and stored.

### Anti-goals (failure even if it technically works)
- The zoomed-in view gets slower, choppier or heavier on a phone than it is today.
- Rain visibly appears, vanishes or jumps as it crosses a range edge (apart from the accepted outer-edge doubling).
- The outer ranges' loading delays the 64 km range, i.e. home.
- Invented rain: the blend may never show more than the highest of the ranges it blends at that spot. A weighted average of levels satisfies this.
- A visible change in sharpness at "now", when playback crosses from real frames into the prediction.

## 3. Constraints and facts

- **Ranges:** suffix `1` = 512 km, `2` = 256 km, `3` = 128 km, `4` = 64 km (`RADARS` in `shared/config.ts`, widest first). Each frame is a 512×512 gnomonic image about the radar, so the four frames are nested squares. Every product's native cell is 2×2 px (`CELL_SIZE`): about 0.5 km, 1 km, 2 km and 4 km for 64, 128, 256 and 512 km. Home is about 7 km from Marburg, and about 57 km from the 64 km frame's edge.
- **Pixel mapping between ranges is affine.** All ranges are gnomonic about the same point, so fine px → coarse px is a scale and an offset per axis. Measured for `IDR504` → `IDR503`: scale 0.5005, off-affine error < 0.05 px.
- **Each frame has a 16 px no-data border (found in the live check, 2026-11-03).** Pixels 0–15 and 496–511 carry nothing: on IDR502, 503 and 504 the share of non-zero pixels steps up at exactly 16 px from the edge. So a range's coverage is the 480 px square inside the border, and "frame edge" in §4.2–4.3 means that edge (`DATA_MARGIN_PX` in `src/motion/nest.ts`). With the full 512 px as coverage, a finer range took weight over its blank border and cut a thin line through the coarser range's rain.
- **Frame sizes:** BOM PNGs are 8–12 KB (samples in `shared/__fixtures__/cells/`, captured in widespread rain). A 2 h loop of all four ranges is about 1 MB. Download size is not a concern **(user agreed: "the images are tiny")**.
- **The real costs are on the phone:**
  - *Memory:* a decoded frame is 512×512 bytes = 256 KB. `DECODED_CAP_MS` = 6 h keeps ~72 frames per product, about 18 MB. Today the app decodes **two** products (`IDR503` for the map and `IDR504` for the tape), each with the full window, and never drops a product once loaded. So today's worst case is about 36 MB, and the usual 2 h case about 12 MB. Four ranges at the full window would be about 75 MB.
  - *Motion:* one flow per adjacent pair, one at a time (`pumpFlows`). The plan measured under 150 ms per pair in Node; expect 0.3–0.5 s on a phone.
- **Publishing offsets:** ranges publish at slightly different minutes; wider ranges can be a couple of minutes ahead. Each range's newest frame has its own time, so its nowcast lead differs by a few minutes from its neighbours'.
- **WebGL2:** the shader currently has 2 slots of 3 textures each (A, B, flow) plus the LUT. Four slots plus a shared nowcast-motion texture need 14 texture units; WebGL2 guarantees at least 16 in the fragment shader.
- **GPU/CPU parity:** `INTERP_GLSL` is a line-for-line port of `src/motion/interpolate.ts`, and `parity.ts` checks it. The nested sampling must stay that way: a TypeScript master copy, ported to GLSL, checked by the parity test.
- **Map zoom:** there is no minimum zoom now (no `minZoom` in `src/`). With the 512 km range drawn, the radar ends at the edge of a ~1024 km square.

## 4. What the user sees

### 4.1 Nesting **(user)**
- All loaded ranges of the active radar are drawn in **one pass**, finer ranges taking priority.
- **Zoom no longer switches ranges.** The 300 ms crossfade on zoom (`CROSSFADE_MS`) goes away, and with it `pickRange`'s role of choosing *the* range. Zooming only shows more or less of the nest.
- Same behaviour when scrubbing the past, during playback and in the nowcast.

### 4.2 Blend at the edges **(user: narrow blend)**
- At each finer range's frame edge, its weight fades from 1 to 0 over a band **inside** its frame: about **5 km** at the 64 km → 128 km edge.
- **(call)** The wider edges (128 → 256, 256 → 512) use a band scaled to the coarser side's cell size, about 3 of its cells (~6 km and ~12 km), so the blend isn't narrower than one coarse cell. The builder tunes the exact widths by eye.
- **(call)** Blend **levels**, then colour, as the mockup did: `level = w·fine + (1 − w)·coarse`. Not premultiplied colours, which would mix hues. The nowcast opacity (`forecastOpacity`) is applied per range and blended with the same weights, since the ranges' leads differ by a few minutes.
- **(call)** The weight curve is a smoothstep across the band.

### 4.3 Where a range has no data **(call; important)**
"Finest available" means the weight counts only where a range actually has data:
- **No pair for the current time** (not loaded, not decoded, or no flow yet): weight 0, so the next coarser range that has data shows through. If no coarser range has data either, that area is blank, like off-radar areas now. No spinner.
- **Kept pairs:** as today, each range keeps its last drawn pair when a new one isn't decoded yet. But nested, a stale pair next to fresh neighbours makes rain jump at the ring edge. So a kept pair counts as data only while its time is within **one frame interval (~5 min)** of the time being drawn. Beyond that, its weight is 0. **Exception:** where no range has data within that tolerance, the finest kept pair is drawn anyway, which is today's behaviour, so scrubbing quickly into undecoded frames never blanks the map.
- **Reading from outside the frame.** A range's nowcast at pixel `p` reads its newest image at a source point upstream of `p` (§4.4). When that source point lies outside the range's frame, the range doesn't know what's there. Today it reads 0, which is why "the upwind edge of the 64 km range empties by +40–60 min" (main spec §7.7). So a range's weight at `p` uses the distance to its frame edge of **both** `p` and its source point, whichever is smaller, with the same blend band. Where the source point is outside, the coarser range takes over. §9 measured this as the biggest gain in nowcast accuracy.
- The same rule applies to in-between frames (`A(p − α·F)` and `B(p + (1−α)·F)`): use the smallest edge distance among `p` and the two source points. The displacements are small there (a few km), so this mostly matters at the frame edge.

### 4.4 The nowcast **(user, after §9)**
- **One motion field per region.** Inside the 128 km frame, the nowcast motion `V` is the **128 km range's** forecast flow (`forecastFlow` over its last ≤ 3 pairs, as now), for **every** range drawn there, including the 64 km range. Outside the 128 km frame, the 256 km and 512 km ranges each use their own forecast flow **(call)**.
- **Each range moves its own newest image.** At pixel `p` and time `t`, a range whose newest frame is at `t_r` reads its newest image at `p − (t − t_r)·V(p)`, with `V` looked up once at `p` and converted between pixel grids with the affine mapping (§3). The lead differs per range by its newest frame's age; the motion doesn't.
- The 64 km image therefore keeps its detail in the prediction, so nothing visibly changes at "now" (anti-goal 5). §9 found the 128 km range's own prediction scores the same as this, but would blur at "now".
- Where the source point lies outside a finer range's frame, the coarser range's image fills in (§4.3).
- **Until the 128 km range's forecast flow is ready** (start-up, or right after a radar switch), the 64 km range uses its own forecast flow, which is today's behaviour **(call)**. The swap happens when the 128 km flow arrives. A small jump in the prediction at that moment is acceptable.
- Opacity fading with lead (`forecastOpacity`), the 60 min limit and the clock's "+N min forecast" are unchanged.

## 5. Loading and priority **(user agreed to the playback; details are calls)**

- **Always loaded:** the 64 km range (the tape's product), with the full `DECODED_CAP_MS` window as now. **Plus the 128 km range's newest ~4 frames** (newest + `FORECAST_PAIRS` pairs) and their 3 flows, for the nowcast motion and the rain from outside the 64 km square (§4.4). Stated generally, for §10: the tape product, plus the newest frames of whichever ranges supply the nowcast motion and the outside rain at home. That's about 1 MB decoded and 3 motion calculations, queued after the 64 km range's current-time pair and its own newest flows **(user approved this cost)**. Zoomed in around home, nothing else loads.
- **(call)** A coarser range is **needed** in full (beyond those newest frames) when part of its frame is on screen **and** not already covered by the finer ranges' full-weight areas, i.e. some visible spot would show it.
- **Startup (call):** the 64 km range, the 128 km range's newest frames, plus whatever ranges the initial view needs. This replaces "load `IDR503` first" (`FrameStore.startProduct`).
- **Per-range decode windows (call):** the 64 km range keeps the full 6 h. The coarser ranges get a shorter window around the focus: about the visible tape span plus a margin, at least the default 2 h. Their newest frames used by the nowcast are always kept. Target: decoded memory with all four ranges loaded at most **~48 MB**, i.e. today's real worst case (~36 MB, §3) plus about 12 MB. Zoomed in, it should be well under today's, because `IDR503` no longer keeps 6 h just because it was loaded at startup. The builder picks the exact windows.
- **A range that is no longer needed (call):** stop queuing its frames and flows. Its decoded frames may stay until evicted by the window rules, and are dropped if memory needs it. The builder decides when, as long as zooming back out soon after doesn't refetch everything. Fetched PNGs are HTTP-cached anyway.
- **Motion priority (call):** first, the pairs needed to draw the **current time** for every needed range, finest first, with the 128 km nowcast flows right after the 64 km range's. Then the rest, nearest the focus first, finer ranges winning ties. Home's playback is never held behind the outer rings, and the outer rings get one drawable pair quickly instead of waiting behind 70 pairs of the 64 km range.
- **Decode/fetch priority:** same idea. Frames for the current time first, finest range first, then nearest the focus.
- Zoomed out, the outer rings may appear a moment later, or play choppier for a few seconds before their motion arrives. **Accepted (user, via the playback).**

### 5.1 What "now" is **(call)**
- Today, "now" (`loadedWindow().end`) is the newest stamp over the *loaded* products. Ranges will now load and unload with zoom, and the wider ones publish a couple of minutes ahead, so "now" would jump forward when zooming out and back when a range is dropped.
- So **"now" becomes the tape product's newest frame** (the 64 km range, for the current home). It is always loaded, the tape's nowcast already starts there, and it doesn't move with zoom. The live playhead, live-following, the clock's "+N min forecast", the tape's nowcast section, the auto-stop at "now" and the nowcast's 60 min limit all use it.
- Consequence: the live view is a couple of minutes behind today's, which used `IDR503`'s newer stamp. Outer rings whose newest frame is later than "now" simply draw their real data at "now", and their own nowcast only past their own newest frame.

## 6. The tape and the rain hint **(user)**

- **The past is unchanged:** the 64 km range, sampled as now (`buildHomeSeries`, and the server's per-frame series above 3 h of span). Home is always well inside the 64 km frame, so the nested map shows the same thing there.
- **The nowcast section and the rain hint use the nested prediction at home** (§4.4): the 64 km newest image moved with the 128 km motion, and the 128 km image where the source point leaves the 64 km frame, with the same weights as the map. `buildHomeForecast` switches to the TypeScript master copy of the nested sampler (§7), still taking the max over the home disc's cells. The map and the tape then agree by construction, including fast storms from beyond 60 km.
- Until the 128 km nowcast flow is ready, the tape uses the 64 km range's own, like the map (§4.4).

## 7. Architecture notes (for the builder)

- **One `RadarLayer` drawing N ranges** replaces the crossfade pair. The crossfade machinery (`setCrossfade`, the owner/other hand-off, `CROSSFADE_MS`, `RadarView`'s `cur`/`next` slots) can go. A radar switch (Marburg ↔ Stapylton) swaps the whole set; a fade there is optional **(call)**.
- **Shader:** up to 4 slots, ordered finest first. Per pixel, for each slot from finest to coarsest: compute the weight (§4.2–4.3), sample the level only if the weight is > 0, and stop once the accumulated weight reaches 1. Inside full-weight areas, that's one range sampled per pixel, as today; only pixels in a blend band sample two.
- **Nowcast uniforms:** per slot, its newest image, its lead (`t − t_r`) and the affine mapping from its pixels to the motion field's pixels. Plus one shared motion texture per region (the 128 km forecast flow; the 256/512 km ranges keep their own). In the nowcast, the per-slot B texture and pair flow are unused.
- **CPU master copy:** a nested sampler in TypeScript next to `sampleForecast` (`src/motion/interpolate.ts`) computes exactly what the shader does, for the tape and for `parity.ts`. The spike's `m128+nested` code (§9) is a working sketch of it.
- **Draw quad:** the union of the drawn ranges' quads, which in practice is the widest drawn range's quad.
- **Per-range state** is what `RadarView.drawSlot` does now: the geometry, and the last pair, kept when a new one isn't decoded yet. Kept pairs also carry their time, for §4.3's tolerance.
- **"Now"** (§5.1) needs a store accessor for the tape product's newest frame, used in place of `loadedWindow().end` by `RadarScreen`, `RadarView` and `Tape`.
- **FrameStore:** priority-aware scheduling for several products (§5), a per-product decode window, the 128 km range's newest frames kept loaded, and an accessor for the shared nowcast motion. Today one window and one nearest-first order is shared by all products, and products are never dropped once ensured.
- **Testing (lean, per the user's preference):** the blend weight, the nested nowcast sampler and the "which ranges are needed" logic as pure TypeScript functions with small tests. The parity check covers the nested sampler. A live check on a phone-sized viewport zoomed in and zoomed out, watching memory in DevTools.
- **Spec upkeep:** once built, update the main spec's §7.5 to point here, and its §7.7: the motion source (§4.4), the rain hint's source (§6), and the known limits. The "upwind edge empties" and "a fast storm still more than ~60 km away can be missed" limits go away inside the 128 km square.

## 8. Left to the builder

- Exact blend widths and curve, tuned on real frames (§4.2).
- The outer ranges' decode window, within the memory target (§5).
- When unneeded ranges' frames are dropped (§5).
- Whether a radar switch fades or swaps (§7).
- How the store's priorities are implemented, as long as §5's order holds.

## 9. Evidence: which nowcast motion predicts best (spike, 2026-11-03)

A throwaway script (not in the repo) replayed the app's own flow and forecast code over the archive. **Data:** four rain events, 27 Oct 06–10 UTC, 28 Oct 00–08, 30 Oct 12–24 and 1 Nov 00–03. **Method:** 110 start times, every 15 min, Marburg `IDR504` and `IDR503`, predicting +15 to +60 min. Each prediction was scored over the whole 64 km square against the `IDR504` frame that actually arrived, using the fractions skill score (FSS; 1 = perfect, tolerant of position error within the window). It also counted rain at home (≥ 0.5 in the 1 km disc) as hit / miss / false alarm.

Light rain (≥ 0.5), 5 km window; the 20 km window and moderate rain (≥ 3.5) rank the same:

| Method | +15 | +30 | +45 | +60 | Home CSI |
|---|---|---|---|---|---|
| No motion (persistence) | 0.71 | 0.61 | 0.55 | 0.51 | 0.39 |
| 64 km motion, 64 km image (today's tape) | 0.80 | 0.63 | 0.50 | 0.39 | 0.51 |
| 64 km motion, nested image | 0.86 | 0.75 | 0.67 | 0.62 | 0.57 |
| 128 km motion, 64 km image only | 0.82 | 0.64 | 0.50 | 0.37 | 0.53 |
| **128 km motion, nested image (chosen)** | **0.88** | **0.77** | **0.68** | 0.61 | **0.58** |
| 128 km image and motion (today's zoomed-out map) | 0.88 | 0.77 | 0.68 | 0.61 | 0.58 |

Findings:
1. **The nested image is the big win.** Reading 0 from outside the 64 km frame makes today's tape nowcast worse than persistence by +45 min. Taking that rain from the 128 km range adds about 0.23 at +60. This held in three of the four events and overall by a wide margin; the small 27 Oct event, which never rained at home, went slightly the other way.
2. **The motion source matters much less.** 128 km motion is a little better up to +30 min, especially for moderate rain, and level by +60. It varies by event, so it's a lean, not proof. It was chosen because it is at least as good and removes the motion seam at the 64 km edge.
3. **The 64 km image's detail adds no measurable skill.** The 128 km range's own prediction scores the same. The 64 km image is still used (§4.4) so the map doesn't blur at "now".

Limits: 8 days of archive, one flow algorithm, Marburg only.

## 10. Later: a movable home **(user, 2026-11-03; not part of this work)**

The user plans to replace the hard-coded `HOME` with the device's location or a typed address. This work shouldn't build that, but it shouldn't make it harder either:
- **Nesting, blending and the shared nowcast motion (§4) don't depend on home.** They depend only on the radar's geography.
- **Don't hard-code "home is in the 64 km square".** Write the always-loaded set (§5), "now" (§5.1) and the tape's nowcast (§6) in terms of **the tape product**: the finest range covering home, which today is `RADARS[radar].tapeProduct`. A home in the 128 km ring would then make 128 km the tape product, with the 256 km range's newest frames supplying the outside rain. The tape's nowcast sampler takes home's pixel as an input, as `homePixel(geom)` does now.
- **Known later problems, noted not solved:** the server samples rain at the fixed `HOME` during ingest (`sampleHomeFromPng`, served by `/api/series`), and the tape uses those values above 3 h of span. A per-user home needs another source for long spans. A home outside both radars' coverage needs radar choice (`chooseRadar`, `RADARS`) to stop being Marburg/Stapylton only. The 57 km and "home is near the radar" figures in §3 and §9 hold for the current home only.
