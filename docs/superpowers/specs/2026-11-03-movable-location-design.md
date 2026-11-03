# Movable location: design

Date: 2026-11-03. Replaces the hard-coded `HOME` (Calvert) with a location the user picks: the device's position or a searched place. Builds on the nested-ranges design (`2026-11-03-nested-ranges-design.md`, §10 "a movable home") and the main rain-radar design (`2026-10-27-rain-radar-design.md`).

Markers: **(user)** = the user decided it; **(call)** = the designer's call, open to change.

## 1. Intent

Today the pin, the tape, and the rain hint are fixed at Calvert, and the worker samples rain there for every frame it ingests. The user wants the pin, the tape graph, and the rain hint to follow **their own location or a typed place (user)**. All rain-at-a-location analysis moves to the phone. The worker **only downloads and stores frames (user)**.

Brisbane is the default **(user)**. The user often finds Marburg less detailed and sees it as Brisbane's backup radar, so the app picks the **nearer radar to the location, with a manual Marburg/Stapylton switch (user)**.

## 2. Goals, non-goals, anti-goals

**Goals**
1. The location is either a one-shot device fix or a searched place, and **it's remembered between visits (user)**.
2. The map pin, the tape (past and nowcast), and the rain hint all read rain at the current location.
3. The radar is picked automatically by distance, and the user can override it by hand.
4. The worker does no per-location work. `/api/series` and the ingest-time home sample are removed.
5. The tape's long view (span > 3 h) still works, computed on the phone, with a loading indicator while it fills **(user)**. Downloaded frames are cached on the phone and **cleared out at 7 days (user)**.

**Non-goals**
- **Radars other than Marburg and Stapylton (user).** Coverage stays at those two.
- **Following the user as they move (user).** ◎ takes one fix and stays there until tapped again.
- Saved or favourite places, a recent-places list, or setting the location by tapping the map **(call)**. None of these were asked for, and layout A has no room for them.
- Time zones other than Brisbane. The tape labels stay on Brisbane time **(call)**, even for northern NSW places inside coverage, which run on daylight saving.
- Making 7-day tapes fast. The user said going back 7 days is very unlikely **(user)**, so the long view just has to work, not be quick.

**Anti-goals**
- The map, tape, and hint disagreeing about where "here" is. They must all use the same point.
- Any remaining dependence on Calvert. No `HOME` constant, and no code that assumes the location is in the 64 km square or near Marburg (the nested-ranges spec already warned about this).
- A slow first open. Location permission and geocoding must never block the map from drawing. The app draws Brisbane first and moves when a fix arrives.

## 3. Current state (what changes)

- `HOME` lives in `shared/config.ts`. It's read by `homePixel` (`shared/homeSample.ts`) and by the map centre and marker (`src/radar/RadarScreen.tsx`).
- `RADARS[radar].tapeProduct` is static: `IDR504` for Marburg and `IDR663` for Stapylton. Stapylton's is the 128 km range because Calvert is 73 km out. It's read in `frameStore.ts`, `Tape.tsx`, `RadarScreen.tsx`, and `worker/ingest.ts`.
- `chooseRadar` (`src/data/chooseRadar.ts`) always prefers Marburg and falls back to Stapylton once Marburg's newest frame is over 20 min old.
- The worker samples rain at `HOME` for each new tape-product frame (`sampleHomeFromPng`, `worker/ingest.ts` ~L138–172) and stores it as R2 custom metadata. `/api/series/:product/:day` (`worker/api.ts` ~L132) serves those samples, and the tape uses them above `SERIES_SOURCE_SWITCH_MS` (3 h).
- The tape already shows a faint hatch wherever it has no value yet.
- Frames in R2 are immutable, served with `max-age=31536000, immutable`, and kept forever.

## 4. The location

### 4.1 State
- The location is `{ lat, lon }`. *(call: also keep a display name when it came from a search. Nothing shows it today, but it costs nothing and helps later.)*
- It's saved on the phone (localStorage is enough, **call**) together with the radar override (§5).
- **First open, nothing saved (user):** start at Brisbane (CBD, about −27.4698, 153.0251), then straight away request a location fix as if ◎ had been tapped. The map draws Brisbane while the request is pending.
- **Every later open (user):** restore the saved location. No automatic fix.

### 4.2 "Use my location" (◎)
- **One-shot (user).** A single `getCurrentPosition`, then the pin stays put. *(call: high accuracy off, and a timeout of about 10 s.)*
- Success inside coverage (§4.4): set the location, save it, and centre the map on it at the current zoom **(call)**.
- **Permission denied, an error, or a timeout (call):** keep the current location. On first open that's Brisbane. Show a brief, unobtrusive message ("Couldn't get your location") that disappears by itself. Tapping ◎ again tries again.
- No `watchPosition`.

### 4.3 Search (🔍)
- Tapping 🔍 opens a search field across the top of the screen with suggestions as you type. Picking one sets the location, saves it, closes the field, and centres the map on it. Escape, or tapping away, closes the field without changing anything.
- **Geocoder (call): Photon** (`photon.komoot.io`), a free OpenStreetMap-based geocoder that allows search-as-you-type and needs no API key. Requests are limited to the coverage box (`bbox`) and biased toward the current location. Debounce about 300 ms. OpenStreetMap is already credited in the status bar. Nominatim is out because its usage policy forbids search-as-you-type.
- Photon sees what the user types. That's acceptable for a personal app **(call)**.

### 4.4 Coverage
- A location is **covered** if it lies inside the widest frame (512 km) of either radar.
- A search result or device fix outside coverage is not applied **(call)**. The location stays where it was, with the same kind of brief message ("Outside radar coverage"). Search results should rarely hit this because of the `bbox`.

## 5. Radar choice

- **Automatic (user):** the radar whose centre is nearer the location. The centres are in the main spec: Marburg −27.608, 152.539, and Stapylton −27.718, 153.240.
- **Manual (user):** the two-way **Marburg | Stapylton** switch (§7) shows the radar in use. Tapping the other side overrides the automatic choice.
- **How the override lasts (call, flagged to the user, not yet confirmed):** changing location (◎ or search) clears the override and goes back to the nearer radar. The override is saved with the location, so it survives a reload.
- **Stale fallback (call, flagged to the user, not yet confirmed):**
  - Automatic: if the chosen radar's newest frame is over `STALE_SWITCH_MS` (20 min) old and the other radar is fresh, use the other one. This is today's `chooseRadar` logic with "preferred" in place of "Marburg". The status line says it's on the backup: "Mt Stapylton radar (backup)" or "Marburg radar (backup)".
  - Overridden by hand: stay on the chosen radar and show the existing "⚠ updated N min ago" warning.
- `chooseRadar` takes the preferred radar and an "overridden" flag, and returns which radar to use and whether that's a fallback. `FrameStore` gets these from the location state instead of always preferring Marburg.

## 6. The tape product and sampling at the location

### 6.1 The tape product is computed
- **The tape product is the finest range of the active radar whose frame contains the location's 1 km disc** (nested-ranges spec §10). It replaces the static `RADARS[*].tapeProduct`. Examples: Calvert on Marburg gives `IDR504`, Brisbane on Stapylton gives `IDR664`, and Calvert on Stapylton gives `IDR663`.
- It changes when the location or the radar changes. Everything that now reads `RADARS[radar].tapeProduct` reads the store's current tape product instead. That covers the always-loaded set, "now", `tapeProducts()`, the tape, and the hint.
- "Contains" needs the ranges' geometry. Before the metas have loaded, the builder may fall back to the widest range or wait for the metas. Either is fine as long as the result corrects itself once the geometry arrives.

### 6.2 Sampling at a point
- `homePixel(g)` becomes `pointPixel(g, point)`, with the same maths and the location passed in. `sampleHomeFromPng(png, g)` becomes `samplePointFromPng(png, g, point)`. It's already browser-safe (it uses `DecompressionStream`) and only inflates the rows down to the disc. `maxLevelInDisc`, `buildHomeSeries`, and `buildHomeForecast` take the point as a parameter. *(Renaming "home" to "location" is the builder's call. Do it where it's cheap.)*
- `HOME_RADIUS_M` (1 km disc, max over native cells) is unchanged.

### 6.3 Changing location at runtime
- Moving the location must:
  - move the pin;
  - recompute the tape product, and through it the radar if automatic (§5);
  - point the store at the new tape set (`switchRadar` if the radar changed, otherwise a tape-product change inside the same radar);
  - rebuild the tape's series and the nowcast at the new point;
  - refresh the rain hint.
- No reload is needed.

## 7. Screen (layout A, user)

As in the visual-companion mockup `location-controls.html`, option A:
- **🔍 button at top-left and ◎ button at top-right**, round, in the existing control style (dark translucent fill, `--control-border`), level with the clock and clear of it. The speed lever stays below on the right.
- The **red pin** (the existing MapLibre `Marker`) moves to the location.
- A **Marburg | Stapylton** two-way switch sits to the right of the play button, mirroring the legend on the left in the existing `1fr auto 1fr` grid. The selected side is the radar in use.
- The search field (§4.3) covers the top of the screen while it's open, with suggestions in a list below it.
- The status line keeps its "(backup)" note for the automatic fallback (§5).

## 8. Tape: long spans on the phone

- **Short spans (≤ 3 h): unchanged.** Interpolated 30 s samples from the decoded pairs at the location's pixel.
- **Long spans (> 3 h):** instead of `fetchSeries`, the phone fetches the tape product's frames for the visible time range and runs `samplePointFromPng` on each. That gives one `[stamp, level]` point per frame, the same shape as `SeriesDay["points"]`, so `seriesToColumns` is reused as is.
  - The stamps come from the store's existing day listings (`fetchDay` / `extendBack`), so no new endpoint is needed.
  - Only what's on screen is fetched, plus a small margin. Work starts at the playhead and spreads outward **(call)**, with a few requests in flight at a time **(call, around 4–6)**. Panning or zooming away cancels or deprioritises work that's no longer visible.
  - The sampled points are kept in memory per `product/location`, so redrawing doesn't resample. They're cheap enough to recompute that only the frames themselves are cached across visits (§9).
- **Loading indicator (user, "a skeleton or other loading indicator is fine"):** columns with no value yet show the existing hatch. *(call: animate the hatch, a slow drift or shimmer, while long-span frames are still being fetched or sampled, so "loading" looks different from "no data".)*
- The nowcast section is unchanged at every span.

## 9. On-device frame cache

- **What's cached (call):** the frame PNGs, keyed by URL. Frames are immutable, so moving the location reuses every frame already on the phone and only the cheap sampling reruns.
- **Where (call):** the browser's Cache API or IndexedDB, which both survive reloads. It sits under `fetchFrame`, so the map's own frame loads benefit too, not only the long tape.
- **Clearing out (user: "clears out at the 7 day mark"):** entries are dropped once they're **7 days old, counted from when they were cached (call)**. For the usual recent frames that's the same as the frame being 7 days old, and it means scrolling back through an old storm isn't thrown away straight after. The sweep runs on startup and occasionally after that **(call)**.
- If storage fails or is full, frames still load from the network, and caching just stops. That's never an error the user sees.

## 10. Worker

- Ingest stops sampling. Remove the geometry-before-put step for the tape product, the `customMetadata.home` write, and the `sampleHomeFromPng` import (`worker/ingest.ts` ~L138–172). Ingest no longer needs a tape product at all. Keep the hourly meta refresh for every product.
- Remove the `/api/series` route, `SeriesDay`'s server use, `fetchSeries`, and their tests. *(call: remove, not just stop using, so nothing tied to Calvert stays behind.)* Old R2 objects keep their `home` metadata. It's harmless and doesn't need to be cleaned up.
- Remove `HOME` from `shared/config.ts`. Calvert's coordinates no longer ship in the bundle, which the main spec had noted as a privacy wart.
- `RADARS` loses `tapeProduct`, which becomes runtime state (§6.1), and gains each radar's centre, for the distance choice and the coverage check.

## 11. Docs

Update the main spec where it states the fixed home: the home location bullet, the home pin, the tape's source above 3 h, `/api/series`, and the worker's home sampling. Mark the nested-ranges spec's §10 "known later problems" as handled by this design.

## 12. Testing (lean, as the project prefers)

- Unit tests:
  - nearest-radar choice and override plus fallback (`chooseRadar`);
  - tape-product choice for Calvert, Brisbane, and a point in the 128 km ring;
  - the coverage check;
  - `samplePointFromPng` and `pointPixel` with a non-Calvert point, by updating the existing `homeSample` tests;
  - cache expiry.
- Live check:
  - first open in a fresh profile goes to Brisbane and Stapylton `IDR664` and asks for permission;
  - a search for "Lowood" moves the pin and switches to Marburg `IDR504`;
  - the radar switch flips the radar;
  - a long tape span fills in behind the animated hatch;
  - a reload restores the location;
  - the worker's ingest still runs and `/api/series` is gone.

## 13. Nowcast to 3 hours (user, added 2026-11-03)

- **`NOWCAST_MAX_MS` goes from 1 h to 3 h (user).** It sets how far the map, the tape's nowcast section, playback, scrubbing, and the rain hint can look ahead.
- **Fade (call):** `forecastOpacity` keeps fading linearly from 1 to `FORECAST_MIN_OPACITY` across the whole nowcast, now 3 h. So +60 min looks a little stronger than it does today, and +3 h looks as faint as +60 min does today. The GLSL copy (`shaders.ts`) reads the same constant.
- **Lead times past an hour read as hours and minutes (call).** The clock shows "+1 h 25 min forecast". The rain hint shows "Rain in ~2 h 10 min · heavy", still rounded to 5 min.
- **Known limit (call, not fixed here):** the tape and the hint read only the tape set: the tape product, its motion range, and the next coarser range (nested-ranges §6). A storm that's beyond the coarser range's square now, but arrives within 3 h, doesn't show on the tape or in the hint, even though a zoomed-out map shows it. Earlier tests also showed the nowcast near persistence skill by +60 min, so the 1–3 h part is a rough guide.

## 14. Left to the builder

- Exact control styling, icons, and the open/close animation of the search field.
- The text of the brief messages.
- The concurrency and prioritisation details of long-span fetching, within §8.
- Cache API vs IndexedDB.
- How the tape product behaves before the metas load (§6.1).
- How far the "home" → "location" rename goes.
