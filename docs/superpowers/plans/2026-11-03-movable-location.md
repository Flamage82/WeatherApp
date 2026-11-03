# Movable Location Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded `HOME` with a user-chosen location (one-shot device fix or Photon search) that the pin, the tape, and the rain hint all follow. Pick the nearer radar automatically, with a manual switch. Move all location sampling onto the phone, behind a 7-day frame cache. Extend the nowcast to 3 h.

**Architecture:**
- The location (`LatLon` plus an optional radar override) lives in `RadarScreen`, is saved to localStorage, and is handed to `FrameStore.setLocation`.
- The store computes the radar (`chooseRadar` with a preferred radar) and the tape product (`chooseTapeProduct`, the finest range whose frame holds the 1 km disc). Everything that read the static `RADARS[*].tapeProduct` reads `store.tapeProduct` instead.
- The tape's long spans sample frames on the phone (`LongSeries`, using `samplePointFromPng`). Frames come through a Cache API layer under `fetchFrame`.
- The worker stops sampling, and `/api/series` is deleted.

**Tech Stack:** TypeScript, React, MapLibre GL, Vite, Vitest, Cloudflare Workers + R2. Photon geocoder (`https://photon.komoot.io/api/`).

**Spec:** `docs/superpowers/specs/2026-11-03-movable-location-design.md` (read it first; § numbers below refer to it). Background: `docs/superpowers/specs/2026-11-03-nested-ranges-design.md`.

## Global Constraints

- **Git staging is user-owned.** Never `git add` or commit. Each task ends with `npm test` and `npx tsc --noEmit` passing, and the user commits.
- **Lean tests.** Write only the tests named in each task. Update existing tests that break. Don't add extra coverage.
- `BRISBANE = { lat: -27.4698, lon: 153.0251 }`. Radar centres: Marburg `{ lat: -27.608, lon: 152.539 }`, Stapylton `{ lat: -27.718, lon: 153.240 }`.
- Coverage: within **500 km** east-west and north-south (equirectangular, about the radar centre) of either radar. This is a slightly conservative stand-in for "inside the 512 km frame".
- `HOME_RADIUS_M = 1000` (unchanged). `STALE_SWITCH_MS = 1_200_000` (unchanged).
- Frame cache: Cache API cache name `"frames-v1"`. Entries expire `7 * 86_400_000` ms after they were stored.
- Geolocation: `getCurrentPosition` with `{ enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 }`. One-shot only; never `watchPosition`.
- Photon: `GET https://photon.komoot.io/api/?q=…&lat=…&lon=…&limit=6&lang=en&bbox=147.3,-32.4,158.5,-22.9`. Debounce 300 ms.
- Long-span sampling: at most **4** frame requests in flight. Nearest the playhead first.
- `NOWCAST_MAX_MS = 10_800_000` (3 h).
- Messages (exact copy): `"Couldn't get your location"`, `"Outside radar coverage"`. They're shown for 3 s.
- localStorage key: `"rain-radar.location"`. Stored value: `{ lat, lon, name?, radarOverride: "marburg" | "stapylton" | null }`.
- After this work, no source file outside tests may contain Calvert's coordinates. Tests that need a point near Marburg define a local `const CALVERT = { lat: -27.67217111736596, lon: 152.49661614726207 }`.

## Review Focus

1. **Location changed while a refresh is in flight:** the store must end up on the *new* location's radar and tape product, not the one the running refresh started with. Test in Task 5.
2. **A saved location that's corrupt, old-shaped, or out of coverage:** the app starts at Brisbane instead of crashing or showing a blank map. Test in Task 2.
3. **A searched place or GPS fix outside coverage (e.g. Sydney):** it's not applied, and the location is unchanged. Test in Task 2 (`inCoverage`) and the live check in Task 10.
4. **A location in the outer few km of the 64 km frame:** the tape uses the 128 km range when the 1 km disc doesn't fit. Test in Task 2.
5. **The Cache API missing (`caches` undefined, as on plain http) or `put` throwing (quota):** frames still load from the network with no error the user sees. Test in Task 6.

---

### Task 1: Point-based sampling in `shared/`

**Files:**
- Modify: `shared/types.ts`, `shared/config.ts`, `shared/homeSample.ts`, `src/tape/homeSeries.ts`, `src/tape/Tape.tsx`, `src/radar/RadarScreen.tsx`, `worker/ingest.ts`
- Test: `shared/homeSample.test.ts`, `shared/gnomonic.test.ts`, `src/tape/homeSeries.test.ts`, `worker/ingest.test.ts`

**Interfaces:**
- Produces:
  - `type LatLon = { lat: number; lon: number }` in `shared/types.ts`.
  - `pointPixel(g: RadarGeometry, p: LatLon): { x: number; y: number; rPx: number }` (replaces `homePixel`).
  - `samplePointFromPng(png: Uint8Array, g: RadarGeometry, p: LatLon): Promise<number>` (replaces `sampleHomeFromPng`).
  - `buildHomeSeries(store, product, geom, point: LatLon, fromMs, toMs)` and `buildHomeForecast(store, products, point: LatLon)`. The point is a new parameter.
  - `RADARS[r]` gains `centre: LatLon` and `checkProduct: ProductId`: `"IDR503"` for Marburg, `"IDR663"` for Stapylton. `tapeProduct` stays for now and is removed in Task 5.

- [ ] **Step 1:** In `shared/homeSample.ts`, make the point a parameter of `pointPixel` and `samplePointFromPng`, with the same maths. Drop the `HOME` import. Fix the doc comment: it's no longer "worker-side".
- [ ] **Step 2:** Thread `point` through `buildHomeSeries` and `buildHomeForecast` (`homeSeries.ts`). Include `point.lat` and `point.lon` in the forecast memo `key`, so a moved location isn't served a stale memo. For now, callers (`Tape.tsx`, `RadarScreen.tsx`, `worker/ingest.ts`) pass `HOME`.
- [ ] **Step 3:** Add `centre` and `checkProduct` to `RADARS` (values in Global Constraints and Interfaces).
- [ ] **Step 4:** Update the tests to call the new names with `HOME`. Then add one test to `homeSample.test.ts`: the existing "placed on rain" test, run with its geometry built around a local `P = { lat: -27.4698, lon: 153.0251 }` instead of `HOME`. `samplePointFromPng(png, g, P)` should equal `maxLevelInDisc(decodeFrame(png), …pointPixel(g, P), 2)`.
- [ ] **Step 5:** Run `npm test` and `npx tsc --noEmit`. Expected: PASS.

### Task 2: Location model and tape-product choice

**Files:**
- Create: `src/location/location.ts`, `src/data/tapeProduct.ts`
- Test: `src/location/location.test.ts`, `src/data/tapeProduct.test.ts`

**Interfaces:**
- Consumes: `LatLon`, `RADARS[r].centre`, `pointPixel` (Task 1). `RadarName` from `src/data/chooseRadar.ts`.
- Produces:
  - `src/location/location.ts`:
    - `type SavedLocation = LatLon & { name?: string; radarOverride: RadarName | null }`
    - `BRISBANE: LatLon`, `LOCATION_KEY = "rain-radar.location"`
    - `loadLocation(s: Pick<Storage, "getItem">): SavedLocation | null`. Returns null when the value is missing, unparsable, has non-finite `lat`/`lon`, has a `radarOverride` that isn't one of the 3 values, or is outside coverage.
    - `saveLocation(s: Pick<Storage, "setItem">, l: SavedLocation): void`. Swallows storage errors.
    - `nearestRadar(p: LatLon): RadarName`
    - `inCoverage(p: LatLon): boolean`
  - `src/data/tapeProduct.ts`:
    - `chooseTapeProduct(radar: RadarName, p: LatLon, geometry: (id: ProductId) => RadarGeometry | null): ProductId`. Picks the finest product of `RADARS[radar].products` whose geometry is loaded and holds the whole disc: `x - rPx >= 0`, `x + rPx <= 511`, and the same for `y`, using `pointPixel`. If none qualifies, returns `products[0]`.

- [ ] **Step 1: Write the failing tests.**
  - `location.test.ts`:
    - `nearestRadar(BRISBANE) === "stapylton"`, `nearestRadar(CALVERT) === "marburg"`.
    - `inCoverage` is true for BRISBANE, CALVERT, Toowoomba `{-27.56, 151.95}`, and Gold Coast `{-28.02, 153.40}`. It's false for Sydney `{-33.87, 151.21}` and Townsville `{-19.26, 146.82}`.
    - `loadLocation` returns null for: no key, `"{"`, `{"lat":"x","lon":1,"radarOverride":null}`, `{"lat":-33.87,"lon":151.21,"radarOverride":null}`, and `{"lat":-27.5,"lon":153,"radarOverride":"brisbane"}`.
    - `saveLocation` then `loadLocation` round-trips `{ ...BRISBANE, name: "Brisbane", radarOverride: "marburg" }`.
  - `tapeProduct.test.ts`, with geometries from the fixtures (`shared/__fixtures__/IDR50x/66x.map`, `worker/__fixtures__/IDR503.map`, via `parseMapFile`, as `gnomonic.test.ts` does):
    - `("marburg", CALVERT) → "IDR504"`
    - `("stapylton", BRISBANE) → "IDR664"`
    - `("stapylton", CALVERT) → "IDR663"`
    - a point 0.3 km inside the IDR504 frame's west edge (build it with `uvToLonLat(g504, 0.3/128, 0.5)`) → `"IDR503"`
    - all geometries missing → `"IDR501"`
- [ ] **Step 2:** Run `npx vitest run src/location src/data/tapeProduct.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement both modules. For `inCoverage`, use east km = Δlon·111.32·cos(lat₀) and north km = Δlat·110.57 about each radar's centre, with both |·| ≤ 500.
- [ ] **Step 4:** Run the same command. Expected: PASS.

### Task 3: `chooseRadar` with a preferred radar

**Files:**
- Modify: `src/data/chooseRadar.ts`
- Test: `src/data/chooseRadar.test.ts`

**Interfaces:**
- Produces:
  - `chooseRadar(m: { marburg: Manifest | null; stapylton: Manifest | null }, nowMs: number, pref: { radar: RadarName; manual: boolean }): RadarChoice`
  - `RadarChoice` gains `fallback: boolean`: true when the radar returned isn't `pref.radar`.
  - Rules:
    - `pref.radar` fresh → it, `"ok"`.
    - `manual` and not fresh → still `pref.radar`, status `"stale"`, or `"empty"` if it has no frames. Never the other radar.
    - Automatic and not fresh: the other radar if it's fresh (`"ok"`, `fallback: true`). Otherwise today's rules with "Marburg" read as "the preferred radar": both stale → the fresher one, ties to the preferred; neither has frames → the preferred, `"empty"`.

- [ ] **Step 1:** Rewrite the existing tests with `pref = { radar: "marburg", manual: false }`, which keeps today's expectations plus `fallback`. Add:
  - preferred Stapylton, 25 min old, Marburg fresh, automatic → `marburg`, `fallback: true`.
  - the same but `manual: true` → `stapylton`, `"stale"`, `fallback: false`.
  - both stale and tied, preferred Stapylton → `stapylton`.
- [ ] **Step 2:** Run `npx vitest run src/data/chooseRadar.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Update the doc comment. For now the caller (`frameStore.ts`) passes `{ radar: "marburg", manual: false }`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.

### Task 4: Worker stops sampling; `/api/series` removed

**Files:**
- Modify: `worker/ingest.ts`, `worker/api.ts`
- Test: `worker/ingest.test.ts`, `worker/api.test.ts`

The client's `fetchSeries` will 404 and get empty points until Task 7 replaces it. That's acceptable mid-branch.

- [ ] **Step 1:** In `ingest.ts`, delete:
  - the tape-product geometry step (`isTape`, the `fetchMeta` call that only it needed, and the `asGeometry` fallback);
  - the `customMetadata.home` write;
  - the `sampleHomeFromPng` import.
  Every product keeps the existing hourly meta refresh path. Check that `fetchMeta` still runs for every product, as `refreshMeta` intends. Update the doc comment ("a tape product with no geometry…" no longer applies). Remove ingest's use of `RADARS[radar].tapeProduct`.
- [ ] **Step 2:** In `api.ts`, delete the `"series"` case and the `SeriesDay` import. `/api/series/...` now falls through to `notFound()`.
- [ ] **Step 3:** In the tests:
  - delete the home-sample tests (`ingest.test.ts` around L281) and the `describe("series")` block (`api.test.ts` L168+);
  - add one assertion: an ingested frame is `put` without `customMetadata`;
  - add one: `GET /api/series/IDR504/20261026` → 404.
- [ ] **Step 4:** Run `npm test` and `npx tsc --noEmit`. Expected: PASS.

### Task 5: `FrameStore` follows the location

**Files:**
- Modify: `src/data/frameStore.ts`, `shared/config.ts`, `src/tape/Tape.tsx`, `src/radar/RadarScreen.tsx`
- Test: `src/data/frameStore.test.ts`

**Interfaces:**
- Consumes: `chooseRadar(…, pref)` (Task 3), `chooseTapeProduct`, `nearestRadar` (Task 2), `RADARS[r].checkProduct` (Task 1).
- Produces:
  - `FrameStoreDeps.location: { point: LatLon; override: RadarName | null }`. This is the initial location.
  - `setLocation(point: LatLon, override: RadarName | null): void`. It stores the location, emits `"change"`, and refreshes. If a refresh is already running, one more runs straight after it, so the final state reflects the last call.
  - `get location(): LatLon`
  - `get tapeProduct(): ProductId | null`, from `chooseTapeProduct(this.radar, point, metas)`; null before a radar is chosen.
  - `fallback: boolean`, from the last `RadarChoice`.
  - `RADARS[*].tapeProduct` is deleted.

- [ ] **Step 1:** In `frameStore.test.ts`, make `fakes()` pass `location: { point: CALVERT, override: null }`. Then:
  - update the Stapylton-fallback test (L624–628) to the tape product that the fake geometry (a 1° box containing CALVERT) now yields: `IDR664`, with `tapeProducts()` → `["IDR664", "IDR663"]`;
  - add "setLocation to BRISBANE switches to Stapylton, tape product IDR664";
  - add "setLocation called twice while a refresh is in flight ends on the second location". Call it with BRISBANE, then CALVERT, before `await store.idle()`. Expect `radar === "marburg"` and `tapeProduct === "IDR504"`.
  - add "override marburg at BRISBANE stays on marburg when Marburg is stale" (`status: "stale"`, `fallback: false`).
- [ ] **Step 2:** Run `npx vitest run src/data/frameStore.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement:
  - `doRefresh` fetches the two radars' `checkProduct` manifests (the old `tapeProduct` ones), with `pref = { radar: override ?? nearestRadar(point), manual: override !== null }`.
  - `ensureMetas(radar)` returns a promise that settles once the radar's metas have all settled. `doRefresh` awaits it before creating products, so the tape product is picked from real geometry.
  - `tapeSet`, `isTape`, `isSupport`, and `loadedWindow` read `this.tapeProduct`.
  - The manifest reuse in `doRefresh` compares against `checkProduct`.
  - When only the tape product changes within the same radar, the products loop in `doRefresh` creates the new tape set's products. The old tape product becomes inactive and is evicted by the budget.
- [ ] **Step 4:** Delete `tapeProduct` from `RADARS` and its type. `Tape.tsx`'s `tapeProduct()` returns `store.tapeProduct`. `RadarScreen` passes `location: { point: HOME, override: null }` for now, and calls `buildHomeForecast(store, store.tapeProducts(), store.location)`. `Tape.tsx` passes `store.location` to `buildHomeSeries` and `buildHomeForecast`.
- [ ] **Step 5:** Run `npm test` and `npx tsc --noEmit`. Expected: PASS.

### Task 6: On-device frame cache

**Files:**
- Create: `src/data/frameCache.ts`
- Modify: `src/data/api.ts`, `src/radar/RadarScreen.tsx`
- Test: `src/data/frameCache.test.ts`

**Interfaces:**
- Produces:
  - `FRAME_CACHE = "frames-v1"`, `FRAME_CACHE_MAX_AGE_MS = 604_800_000`
  - `cachedGet(url: string, get: (url: string) => Promise<Response>, nowMs: number, cs: CacheStorage | undefined = globalThis.caches): Promise<Response>`. Serves a hit from the cache. On a miss it fetches, and if the response is ok, `put`s a copy carrying an `x-cached-at: <nowMs>` header. Any cache error falls back to `get(url)` alone.
  - `sweepFrameCache(nowMs: number, cs = globalThis.caches): Promise<number>`. Deletes entries whose `x-cached-at` is more than `FRAME_CACHE_MAX_AGE_MS` before `nowMs`, or missing. Returns the count. Never throws.
  - `fetchFrame` in `api.ts` goes through `cachedGet`.

- [ ] **Step 1: Write the failing tests** with a small in-memory fake `CacheStorage` (`open` → `{ match, put, delete, keys }`):
  - a second `cachedGet` of the same URL doesn't call `get`;
  - a non-ok response isn't cached;
  - `cs` undefined → `get` is called and its body returned;
  - `put` rejecting → the body is still returned;
  - `sweepFrameCache` with entries stored at `now − 8 d` and `now − 1 d` deletes 1 and keeps 1.
- [ ] **Step 2:** Run `npx vitest run src/data/frameCache.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Wire `fetchFrame`. In `RadarScreen`'s mount effect, call `void sweepFrameCache(Date.now())` once, and again every 6 h while the page is open.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.

### Task 7: Long-span tape on the phone

**Files:**
- Create: `src/tape/longSeries.ts`
- Modify: `src/tape/Tape.tsx`, `src/tape/tapeMath.ts`, `src/data/api.ts`, `shared/types.ts`, `src/radar/RadarScreen.tsx`
- Test: `src/tape/longSeries.test.ts`

**Interfaces:**
- Consumes: `fetchFrame` (cached, Task 6), `samplePointFromPng` (Task 1), `store.frames(p)`, `store.geometry(p)`, `store.tapeProduct`, `store.location`.
- Produces:
  - `new LongSeries(deps: { fetchFrame(p: ProductId, stamp: string): Promise<Uint8Array>; sample(png: Uint8Array, g: RadarGeometry, point: LatLon): Promise<number>; onUpdate(): void; concurrency?: number /* default 4 */ })`
  - `points(p: ProductId, g: RadarGeometry, point: LatLon, stamps: number[], fromMs: number, toMs: number, centreMs: number): { points: [stamp: string, level: number][]; pending: boolean }`. It returns the sampled points inside `[fromMs, toMs]`, ascending. It replaces the work queue with the unsampled stamps in that range, nearest `centreMs` first, so work that's off screen is dropped. `pending` is true while any stamp in range is queued or in flight. A new `p` or `point` drops all results and the queue. A failed stamp is skipped, and retried on a `points` call 30 s or more later. `onUpdate` fires as each sample lands.
  - `SeriesPoint = [stamp: string, level: number]` is exported from `tapeMath.ts` for `seriesToColumns`. `SeriesDay` and `fetchSeries` are deleted.

- [ ] **Step 1: Write the failing tests** with fake `fetchFrame` and `sample` (resolving on demand):
  - with 10 stamps and `concurrency: 2`, only 2 fetches are in flight at first, and they're the 2 nearest `centreMs`;
  - after all resolve, `points` returns all 10 ascending and `pending` is false;
  - a second call with a narrower range doesn't fetch stamps outside it;
  - a call with a different `point` returns no points, then refetches.
- [ ] **Step 2:** Run `npx vitest run src/tape/longSeries.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `LongSeries`.
- [ ] **Step 4:** In `Tape.tsx`:
  - replace `days`, `loadDay`, `dayPoints`, and the series refetch in `onChange` with one `LongSeries` created in the effect, with `onUpdate: requestDraw`;
  - above `SERIES_SOURCE_SWITCH_MS`, call `levels = seriesToColumns(long.points(p, geom, store.location, store.frames(p), from - colMs, Math.min(to, end) + colMs, t).points, from, to, cols)`;
  - while `pending`, shift the hatch pattern's x offset by `performance.now() * 0.006` px (a 6 px/s drift), and keep requesting frames until it's not pending.
  Update the doc comment to say the phone samples frames now, not the server. Update the `SERIES_SOURCE_SWITCH_MS` comment in `tapeMath.ts` the same way.
- [ ] **Step 5:** In `RadarScreen`, add an effect on `spanMs` that calls `store.extendBack(view.time() - spanMs / 2 - EXTEND_STEP_MS)` when the left edge comes within `EXTEND_MARGIN_MS` of `loadedWindow().start`, as `applyTime` does. This lets zooming out alone learn the stamps.
- [ ] **Step 6:** Delete `fetchSeries` and `SeriesDay`. Run `npm test` and `npx tsc --noEmit`. Expected: PASS.

### Task 8: Geocoder and one-shot locate

**Files:**
- Create: `src/location/geocode.ts`, `src/location/locate.ts`
- Test: `src/location/geocode.test.ts`

**Interfaces:**
- Produces:
  - `type Place = LatLon & { name: string; detail: string }`. `name` is Photon's `properties.name`. `detail` is the first two present of `city` / `county` / `state`, joined with ", ", skipping any that equal `name`.
  - `searchPlaces(q: string, near: LatLon, signal: AbortSignal, f: typeof fetch = fetch): Promise<Place[]>`. A query under 2 characters after trimming → `[]` with no request. Uses the URL from Global Constraints. Results outside coverage (`inCoverage`) are dropped.
  - `locateOnce(geo: Geolocation | undefined = navigator.geolocation): Promise<LatLon>`. Rejects if `geo` is undefined or on any error. Options are in Global Constraints.

- [ ] **Step 1: Write the failing test.** A fake `f` returns a two-feature Photon `FeatureCollection` (coordinates are `[lon, lat]`): Lowood (inside coverage) and Sydney (outside). Expect one `Place` with `lat` and `lon` swapped correctly and `name: "Lowood"`. Expect the requested URL to contain `bbox=147.3,-32.4,158.5,-22.9` and `limit=6`. Also expect `searchPlaces("a", …)` to resolve `[]` without calling `f`.
- [ ] **Step 2:** Run `npx vitest run src/location/geocode.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement both modules.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.

### Task 9: Nowcast to 3 hours

**Files:**
- Modify: `shared/config.ts`, `src/controls/formatClock.ts`, `src/controls/rainHint.ts`
- Test: `src/controls/formatClock.test.ts`, `src/controls/rainHint.test.ts`

**Interfaces:**
- Produces: `fmtMinutes(min: number): string` in `formatClock.ts`. Under 60 → `"25 min"`. Otherwise `"1 h 05 min"`, the same style as the clock's past offsets.

- [ ] **Step 1: Write the failing tests:**
  - `formatClock(newest + 85 * MIN, now, newest).rel === "+1 h 25 min forecast"`;
  - `fmtMinutes(130) === "2 h 10 min"`;
  - `rainHint` with rain starting at k = 260 (step 30 s, so 130 min) → `"Rain in ~2 h 10 min · …"`;
  - "until" past 60 min reads the same way.
- [ ] **Step 2:** Run `npx vitest run src/controls`. Expected: FAIL.
- [ ] **Step 3:** Set `NOWCAST_MAX_MS = 10_800_000`. Use `fmtMinutes` in the clock's forecast text and in `rainHint`'s `mins5` output. Leave `forecastOpacity` and its GLSL copy reading the constant, as spec §13 says. Grep for "60 min" and "1 h" in comments that describe the nowcast limit, and update them.
- [ ] **Step 4:** Run `npm test` and `npx tsc --noEmit`. Expected: PASS. (`timeline.test.ts` already uses the constant.)

### Task 10: Location UI and removing `HOME`

**Files:**
- Create: `src/controls/MapButton.tsx`, `src/controls/SearchBox.tsx`, `src/controls/RadarSwitch.tsx`, `src/controls/Toast.tsx`
- Modify: `src/radar/RadarScreen.tsx`, `src/controls/StatusBar.tsx`, `shared/config.ts`. Tests that import `HOME` switch to a local `CALVERT`: `shared/gnomonic.test.ts`, `shared/homeSample.test.ts`, `src/geo/neededRanges.test.ts`, `src/render/geometryUniforms.test.ts`.

**Interfaces:**
- Consumes: everything from Tasks 2, 5, and 8.
- Produces (React components; style them like `PlayButton` and `Legend`, using `--control-border`, `--control-shadow`, and a dark translucent fill):
  - `MapButton({ label: string; onClick(): void; children: ReactNode })`: a 40 px round button, with `aria-label={label}`.
  - `SearchBox({ near: LatLon; onPick(p: Place): void; onClose(): void })`: an input across the top, autofocused, plus a result list. It debounces 300 ms and aborts the previous request. Enter picks the first result, and Escape or a tap outside calls `onClose`.
  - `RadarSwitch({ radar: RadarName | null; onPick(r: RadarName): void })`: two segments, "Marburg" and "Stapylton". The active one is highlighted.
  - `Toast({ message: string | null })`: a small pill above the tape.
  - `StatusBar` gains `fallback: boolean`. Its radar note becomes `" · Mt Stapylton radar (backup)"` or `" · Marburg radar (backup)"`, shown only when `fallback` is true.

- [ ] **Step 1:** In `RadarScreen`:
  - initial state is `loadLocation(localStorage) ?? { ...BRISBANE, radarOverride: null }`, and remember whether one was loaded;
  - the map is centred on it at zoom 9, and the store gets `deps.location`;
  - keep the `Marker` in a ref.
  Add `applyLocation(next: SavedLocation)`. It:
  - checks `inCoverage`, and otherwise shows the toast `"Outside radar coverage"` and returns;
  - saves the location and calls `marker.setLngLat`;
  - calls `map.easeTo({ center })` at the current zoom;
  - calls `store.setLocation(point, next.radarOverride)`.
  Picking a place or a fix sets `radarOverride: null`. The radar switch keeps the point and sets `radarOverride: r`.
- [ ] **Step 2:** Layout:
  - `MapButton` 🔍 at `left: 12, top: calc(10px + env(safe-area-inset-top))`, and ◎ at `right: 12` with the same top;
  - `SearchBox` while open;
  - `RadarSwitch` in the right-hand cell of the existing `1fr auto 1fr` grid (`justifySelf: "end"`);
  - `Toast`, with 3 s messages.
  - ◎ calls `locateOnce()`. Success → `applyLocation`. Failure → `"Couldn't get your location"`.
  - On mount, if nothing was loaded, run the ◎ action once.
- [ ] **Step 3:** Delete `HOME` from `shared/config.ts`. Switch the listed tests to a local `CALVERT`. Rewrite `gnomonic.test.ts`'s "HOME is outside IDR664's frame" as "CALVERT is outside IDR664's frame".
- [ ] **Step 4:** Run `npm test` and `npx tsc --noEmit`. Expected: PASS. Then grep `src shared worker` (non-test files) for `152.4966` and `HOME\b`. Expected: no hits.
- [ ] **Step 5: Live check** (`npm run dev`, phone-sized viewport, fresh profile):
  - it opens on Brisbane, Stapylton, tape `IDR664`, and the permission prompt appears;
  - denying it shows "Couldn't get your location" and stays on Brisbane;
  - searching "Lowood" moves the pin and switches to Marburg (`__radar.store.tapeProduct === "IDR504"`);
  - the switch to Stapylton gives `IDR663`, and a reload keeps Lowood and Stapylton;
  - searching "Sydney" offers no results;
  - zooming the tape out to 1 day shows the drifting hatch, then a filled graph;
  - scrubbing to +2 h shows the map's nowcast, and the clock reads "+2 h 00 min forecast".

### Task 11: Docs

**Files:**
- Modify: `docs/superpowers/specs/2026-10-27-rain-radar-design.md`, `docs/superpowers/specs/2026-11-03-nested-ranges-design.md`

- [ ] **Step 1:** In the main spec, replace the fixed-home statements with a short pointer to the movable-location design:
  - the home location bullet (§ around L51);
  - the home pin (L114);
  - the tape's source above 3 h and `/api/series` (L129 and nearby);
  - the worker's home sampling (L107);
  - the "60 min" nowcast limit (→ 3 h).
  Also mark the nested-ranges spec's §10 "known later problems" as handled by `2026-11-03-movable-location-design.md`.
- [ ] **Step 2:** After deploying (`npm run deploy`), check that `curl …/api/series/IDR504/<today>` returns 404, and that `/api/manifest/IDR504` keeps gaining frames over a few minutes.
