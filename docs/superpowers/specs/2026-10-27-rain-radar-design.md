# Rain Radar — Design

Date: 2026-10-27
Status: draft for approval

Markers used below: **(user)** = decided by the user. **(call)** = the designer's call, which the user hasn't objected to and can still overturn. **(builder)** = deliberately left to whoever plans and builds it.

---

## 1. Intent

A personal web app for one person, used on both phone and desktop, that answers one question better than the Bureau of Meteorology's own site does:

> **"When will that storm hit me, and how heavy will it be?"**

The user answers that question by scrubbing back and forth through radar frames over and over, watching cells move, grow and fade. BOM's data is good, but its loop viewer is clunky: frames jump every 5 minutes, the controls are awkward, and the colours are dated. This app takes BOM's radar frames and presents them with:

- smooth motion *between* frames (rain glides instead of jumping),
- a much better colour treatment,
- controls built for constant scrubbing and speed changes,
- a graph of "rain at my place over time" built into the scrubber itself.

The radar is the first project. A second screen with observations and a forecast is planned and will become the app's *main* screen, with the radar as a secondary screen **(user)**. That screen gets its own design later; this one only needs to leave room for it.

## 2. Goals, non-goals, anti-goals

### Goals
1. Scrubbing feels like holding the timeline in your hand: no lag, no loading stutter, no "frame pop". Target: 60 fps scrubbing and playback on a mid-range phone.
2. Rain moves smoothly between the 5-minute radar frames.
3. You can read "when does it reach me and how intense will it be" at a glance from the tape graph, with no need to scrub first.
4. Works equally well on phone (touch) and desktop (mouse, trackpad, keyboard) **(user)**.
5. Opening the app shows the latest radar fast. Target: first useful picture in under ~2 s on 4G.

### Non-goals (for this version)
- **Predicting storms forward (nowcasting).** The user wants this eventually ("super awesome") but **not in the MVP (user)**. The design must leave room for it (see §9).
- The observations/forecast screen (a separate project, §9).
- Multiple saved locations, location search, or "use my location". The location is **hard-coded (user)**.
- Radars outside the user's area. No national coverage.
- Accounts, login, access control (§4.4).
- Weather warnings, lightning, satellite or other layers.

### Anti-goals (would count as failure even if it technically works)
- Scrubbing that lags behind the finger or drops frames while a frame loads.
- Controls that take over the map, or map gestures (pan/pinch) that fight with time gestures.
- In-between frames that **invent** weather: ghost doubles, smears, or intensities higher than either real frame on each side. Interpolation should look natural but stay honest.
- Looking or feeling like BOM's loop viewer.
- Colours where heavy cores are ambiguous or rain blends into the base map.

## 3. The user and their place

- One user. Home location **(user)**: `-27.67217111736596, 152.49661614726207` (west of Ipswich, near Lowood, SE Queensland). It's hard-coded in one config spot. The user accepted that, with no lock on the site, anyone who finds the URL could read these coordinates from the bundled code.
- Nearby radars, confirmed on BOM's FTP on 2026-10-27:
  - **IDR50x, Marburg.** Centre −27.608, 152.539, about **8 km** from home. **Primary radar (call).**
  - **IDR66x, Brisbane (Mt Stapylton).** Centre −27.718, 153.240, about **73 km** from home. **Backup radar (call)**, used when Marburg is missing or stale.
  - Each radar comes in four ranges: suffix `1` = 512 km, `2` = 256 km, `3` = 128 km, `4` = 64 km. All four exist for both radars.

## 4. Constraints

### 4.1 BOM data (verified 2026-10-27)
- **Source:** anonymous FTP at `ftp://ftp.bom.gov.au/anon/gen/radar/`. Frame files are named `IDR{radar}{range}.T.{YYYYMMDDHHMM}.png`, timestamps in UTC. A new frame arrives about every 5 minutes, and the minute offset differs per radar. The server keeps only about **18–24 frames (roughly 1.5–2 h)** per product. The listing sometimes contains stray `*.png.tmp` files, which must be ignored.
- **Geometry:** `ftp://ftp.bom.gov.au/anon/gen/radar_transparencies/coordinates/IDR{nnn}.map` gives the projection (`Gnomonic`), the radar centre, and the lat/lon of all four image corners. Example, IDR503 (Marburg 128 km): corners from (151.233, −28.748) to (153.857, −26.448). These files let frames be placed exactly on a real map.
- **Image format:** 512×512 PNG, 4-bit **indexed** colour. **The palette varies per file and holds only the colours that file uses, in no fixed order.** Pixels must therefore be classified by **RGB value**, not by palette index. One sample palette was `#000000 #c0c0c0 #000000 #f5f5ff #b4b4ff #7878ff #780000 #00d8c3 #009690 #1414ff #ffffff`, with index 0 transparent.
- **Burned-in text:** each frame has a copyright banner across the top and a station/time label along the bottom. These are drawn in black/white/grey. Only BOM's legend colours count as rain; every other colour is treated as no rain.
- **BOM rain legend, colour → rain rate.** This is the designer's recollection of BOM's standard 15-level scale. **The builder must verify it against BOM's published legend** before relying on it:

  | RGB | mm/h | RGB | mm/h | RGB | mm/h |
  |---|---|---|---|---|---|
  | `#f5f5ff` | 0.2 | `#009690` | 6 | `#ff6400` | 50 |
  | `#b4b4ff` | 0.5 | `#006666` | 10 | `#ff0000` | 80 |
  | `#7878ff` | 1.5 | `#ffff00` | 15 | `#c80000` | 120 |
  | `#1414ff` | 2.5 | `#ffc800` | 20 | `#780000` | 200 |
  | `#00d8c3` | 4 | `#ff9600` | 35 | `#280000` | 360 |

- **HTTPS isn't an option.** `www.bom.gov.au` returns 403 to non-browser clients. Getting around that would mean disguising requests as a browser, which the design rules out. BOM's HTTPS responses also carry no CORS headers, so the browser can't read their pixels. **FTP through a server-side fetcher is the only route (call, agreed with the user).**
- **Licence:** BOM's default copyright terms allow personal, non-commercial use and forbid supplying the data to others. This app is for one person. Show the attribution "Radar data © Commonwealth of Australia, Bureau of Meteorology" on screen **(call)**.

### 4.2 Platform
- **Cloudflare (user).** The user has an account.
- **Front end:** a static React app **(user: "a static site running React or something")**.

### 4.3 Browser
- Must work in current mobile Safari (iOS) and Chrome (Android and desktop). WebGL2 can be assumed.

### 4.4 Access
- **No lock or login (user).** The URL won't be advertised, and the user judged a stranger finding it to be harmless. The fetcher only ever fetches the user's chosen radars, however many people visit, so public visits add no load on BOM.

## 5. Architecture **(call)**

```
BOM anonymous FTP ──(every 5 min, cron)──► Cloudflare Worker ──► R2 bucket
                                                │                   (frames + manifests)
                                                ▼
                         same Worker serves:  /           React app (static assets)
                                              /api/...    manifests + frame PNGs from R2
                                                ▲
                                     browser (phone / desktop)
```

- **One Cloudflare Worker** does three jobs: (a) serves the built React app as Workers static assets; (b) answers `/api/*` from R2; (c) runs on a **cron trigger every minute** to fetch new frames. It alternates between radars, Marburg on even minutes and Stapylton on odd, so each run stays under the free plan's 10 ms CPU limit (measured in the Task 0 test: 4–9 ms for login + filtered listing + one file). Because the app and the API share an origin, no CORS setup is needed. (Pages Functions can't run cron triggers, which is why this is a Worker rather than Pages.)
- **Fetching:** the Worker speaks FTP over raw TCP using `connect()` from `cloudflare:sockets`. It logs in anonymously, uses passive mode, lists `/anon/gen/radar/`, keeps only files for the configured products (`IDR501–504`, `IDR661–664`) whose timestamps it hasn't already stored, downloads them, and writes them to R2 unchanged. BOM's PNGs pass through unchanged; any decoding happens in the browser. It also fetches the eight `.map` coordinate files once and refreshes them occasionally.
- **R2 layout (builder may adjust):** `frames/{product}/{YYYYMMDDHHMM}.png`, `meta/{product}.map.json`, and `manifest/{product}.json`. A manifest lists the timestamps from the **last 24 hours** and the time of the last successful fetch.
- **Frames are kept forever and never deleted (user).** About 8 KB per frame, so ~18 MB/day or ~6.5 GB/year across the 8 products. That's inside R2's 10 GB free storage for roughly 1.5 years, then a few cents a month. Only stamps older than 24 h are dropped, and only from the manifest, so it stays small. Older frames are found with an R2 `list` on the prefix `frames/{product}/{YYYYMMDD}` (§6.4), so no separate archive index is written.
- **Volume:** 8 products × 288 frames/day ≈ 2,300 small writes/day, far inside free-tier limits.
- **Caching:** frame PNGs never change, so they're served with long, immutable cache headers. Manifests use a short max-age (about 30 s).
- **Health:** each manifest records `lastFetchOk` and `lastError`. To fit the free plan **(user: squeeze onto free, 2026-10-27)**, manifests are only written when something changes. Staleness in the app is therefore judged from the newest frame's age, and `lastFetchOk` is the last time that product actually received frames.
- **Free-plan CPU budget (≤ 10 ms per run):** one combined file listing per radar; a tiny `state/{radar}.json` holding the newest stamp per product, so idle runs skip all manifest reads and writes; radar geometry checked hourly; at most 2 downloads per product per run.

## 6. The screen

Mockups were reviewed with the user in a browser companion. The chosen layout is option **"B + tape graph"**.

### 6.1 Layout (same on phone and desktop; desktop is simply wider)
- **Full-screen map** with the radar on top. A **home pin** marks the hard-coded location.
- **Clock**, large at the top centre: the displayed time in local time (Australia/Brisbane, no daylight saving), with a relative label underneath ("−15 min", "now").
- **The tape** across the bottom. See §6.2.
- **Speed lever:** vertical, on the right side. See §6.3.
- **Play/pause button** below the tape.
- Small, unobtrusive: a staleness indicator ("updated 3 min ago", or a warning if over about 15 min), the radar in use, and the attributions (BOM + base map).
- Room for navigation to the future main screen. For now the app opens straight on the radar **(call)**.

### 6.2 The tape (scrubber + "rain at my place" graph) **(user chose this)**
- A horizontal strip about 64 px tall. The **playhead is a fixed line in the centre**, and the tape scrolls underneath it as you drag, like tape through a reel.
- The tape draws a filled **graph of rain intensity at the home location over time**, coloured with the same scale as the map, so a red peak on the tape means red on the map. Time labels sit along the bottom edge.
- **Drag moves time by however far you drag**, so slow drags give fine control. **A flick keeps the tape coasting and slowing to a stop (call)**.
- **No snapping to frames (call).** Interpolation makes any moment valid, so the playhead can rest at 4:37:30.
- **Visible span:** defaults to 40 minutes across the tape (±20 min around the playhead) **(call)**.
- **Tape zoom (user):** pinch the tape on touch, or Ctrl/⌘ + scroll over it on desktop, to change the span from **20 min up to 7 days**. Zoom is centred on the playhead. Double-tap or double-click resets to 40 min **(call)**. Drag and flick distance scale with the span, so at 7 days a short drag moves hours. Time labels adapt their step (10 min → 1 h → 6 h → 1 day).
- **The graph when zoomed out (call):** decoding every frame in the browser for a multi-day span is too heavy. So the fetch job also records the **raw per-frame "rain at home" value** (no interpolation) for the tape products as each frame arrives. It attaches the value to the stored frame itself as R2 custom metadata, so there are no extra writes. `/api/series/{product}/{YYYYMMDD}` lists that day's frames with their metadata. At spans up to 3 h the tape uses the smooth interpolated values computed in the browser; above 3 h it uses the stored per-frame values. Frames stored before this feature ships have no recorded values, and those stretches show as "no data".
- The tape ends at the newest frame ("now"). With nowcasting later, it continues past "now" as a dashed, faded section (§9).
- **"Rain at my place" (call):** the highest interpolated intensity within about 1 km of home. Taking the highest value smooths over small position errors and pixel noise.
- **Where the tape's data comes from (call):** the tape **always** uses the active radar's sharpest range that covers home. For Marburg that's **IDR504 (64 km, ~250 m per pixel)**; on backup it's Mt Stapylton's 128 km range, IDR663, since home is ~73 km out and outside IDR664. It does **not** follow map zoom, so the graph never changes shape when you zoom. It changes source only when the whole loop switches radar (§7.6). The tape only needs a small patch of pixels around home, so it can be worked out on the CPU from a cropped area of each frame and its motion field. This product's frames and motion fields therefore load at start-up alongside the map's first range (§7.5).

### 6.3 Speed lever **(user chose this)**
- A vertical lever from **−4×** at the bottom, through **0** in the middle, to **+4×** at the top. Negative speeds play backwards.
- **1× = 10 minutes of radar time per second of real time (call)**, so 2 hours plays in 12 s. That's roughly BOM's loop speed, but smooth.
- **It stays where it's left (call).** Play/pause switches between paused and the lever's last non-zero setting.
- Values are continuous. The builder may add light detents at 0, ±1×, ±2× and ±4×.

### 6.4 Playback window and looping **(call)**
- **Scroll back as far as the archive goes (user).** Dragging the tape back has no 24 h wall. Older frames load on demand as you approach the edge of what's loaded. The Worker answers `GET /api/day/{product}/{YYYYMMDD}` (UTC day) with that day's stamps, using an R2 `list` on `frames/{product}/{YYYYMMDD}`. Past days are cached as immutable.
- **Memory cap (call):** the browser keeps at most ~6 h of decoded frames and motion fields per product, evicting whichever are furthest from the playhead.
- **Loop window (call):** the 2 h window that contains the playhead, centred on it where possible and never extending past the newest frame. It's fixed when Play is pressed. At "now" that's the last 2 hours. Scrolled back to yesterday's storm, it loops the 2 hours around the storm.
- Playing forward reaches the end of the loop window, holds for about 1 s, then loops to its start. Playing backward mirrors that.
- New frames arriving while the app is open are added to the end automatically. If the playhead is sitting at "now" it follows the new frame; otherwise it stays put.

### 6.5 Map interaction
- Drag pans and pinch or scroll zooms the map, as usual. **Only the tape and the lever control time**, so map and time gestures never clash.
- Desktop extras **(call)**: Space = play/pause; ← and → step backward or forward (5 min per press, finer with Shift, values left to the builder); `[` and `]` = slower/faster; horizontal trackpad scroll or the mouse wheel over the tape scrubs.

## 7. Rendering

### 7.1 Base map **(call)**
- **MapLibre GL JS** with a free, muted vector base map based on OpenStreetMap, such as OpenFreeMap or Protomaps (builder picks; no API key preferred). Credit OSM on screen.
- Dark style by default and light style in light mode, following the system setting **(call)**. Keep the base map muted so rain stands out.

### 7.2 Colours **(user chose scheme A, "refined classic")**
- The familiar weather-radar rainbow with muddy colours removed: very light blue → blue → green → yellow → orange → red → magenta for the most severe.
- **Continuous blending** across BOM's 15 levels, driven by intensity, instead of 15 hard bands. Light rain fades towards transparent at its faint end so the map stays readable.
- Reference stops from the approved mockup, light to severe: `#81d4fa → #29b6f6 → #43a047 → #fdd835 → #fb8c00 → #e53935 → #d81b9a`. The builder maps these stops onto the mm/h scale on a log axis and tunes them on real data.
- The tape graph uses the same colours.
- A small legend is available, collapsed by default **(call)**.

### 7.3 From PNG to intensity field
- Decode each PNG in the browser, classify every pixel by RGB against the BOM legend (§4.1), and produce a 512×512 single-channel **intensity field** (log mm/h, or the level 0–15). Anything not in the legend counts as zero.
- Draw the field as a custom WebGL layer in MapLibre. The fragment shader reprojects from the frame's **gnomonic** projection, using the `.map` centre and corners, into the map's Web Mercator projection, then applies the colour ramp. Upsampling should be smooth (bilinear on the intensity, *then* colour), not blocky.

### 7.4 Smooth motion between frames **(call; the algorithm is the builder's)**
- For each pair of neighbouring frames, estimate a dense **motion field**, i.e. optical flow: which way and how far each patch of rain moved. Do this on the intensity fields, ideally in a Web Worker or on the GPU, as frames arrive.
- To draw time *t* between frames A and B (fraction α): warp A forward by α × flow and B backward by (1−α) × flow, then blend by α. The result must not exceed the higher of the two warped intensities at any point (anti-goal: inventing weather).
- Where the flow is unreliable, e.g. cells forming or dying, fall back gracefully to a crossfade there instead of smearing.
- The motion fields are **kept around**, because nowcasting (§9) extrapolates them past the newest frame.
- Candidate approaches the builder may evaluate: pyramidal Lucas–Kanade, a TV-L1 or Farnebäck-style dense flow, or block matching/phase correlation on a coarse grid followed by smoothing. Radar fields are small (512²) and the window holds about 24 pairs, so computing once per pair is affordable.

### 7.5 Picking a range as you zoom **(call)**
- The app shows the sharpest range of the active radar that covers the visible map: 64 km when zoomed in tight, up to 512 km zoomed right out. When the choice changes, it cross-fades between ranges.
- Frames and motion fields are handled per range. On start-up, load the **128 km** range (`IDR503`) first for the map, along with the tape's source (`IDR504`, §6.2). Load other ranges when zoom calls for them.
- Because interpolation is per range, mixing ranges inside one animation isn't required.

### 7.6 Backup radar **(call)**
- If Marburg's newest frame is over about 20 min old, or frames are missing, switch the whole loop to Mt Stapylton (IDR66x) and say so on screen. Never mix the two radars within one loop. A manual switch between radars is nice to have, if cheap.

## 8. Risks and the first spike

1. **Can a Worker speak FTP to BOM? This is the biggest unknown.** Passive-mode FTP needs a second TCP connection to a port the server picks. Settle it first with a **throwaway spike**: a Worker that logs in, lists the directory, pulls one `IDR503` frame and writes it to R2. Also measure CPU time against the plan's limits; the free plan's per-run CPU limit may be tight even though most of the time is spent waiting on the network.
   - **Budget (user):** stay on the free plan where possible. The user "would consider" Workers Paid (US$5/month). If the spike exceeds free-plan CPU limits, first try cheap reductions: spread products across cron runs, list once per run, and so on. If those fail, **ask the user** before switching to Paid.
   - **Fallback if FTP from a Worker fails:** the user has an always-on **Raspberry Pi running Home Assistant** at home **(user)**. Run the fetcher there as a small scheduled job that downloads over FTP and uploads to R2 through R2's S3-compatible API, using a scoped R2 API token. The Pi is on Starlink behind CGNAT, which is **fine**, because the fetcher only makes outgoing connections and nothing ever connects in to the Pi. The Worker keeps serving the app and `/api/*` from R2; only the cron job moves. How to package it (a Home Assistant add-on, a Docker container, or a systemd timer) depends on how Home Assistant is installed on the Pi **(builder; check with the user)**.
2. **Quality of the in-between frames.** Radar flow is fiddly, because cells grow and decay as they move. Prototype it early on real frames, ideally a stormy afternoon saved from R2, before polishing the UI.
3. **Smoothness on phones.** Keep everything for the current window (intensity textures, flow fields) on the GPU, and keep per-frame work tiny.
4. **The legend table in §4.1 comes from memory.** Verify it.
5. **BOM changes formats or paths.** Fail visibly (staleness indicator), not silently.

## 9. Leaving room for later

- **Nowcasting (user: wanted, not MVP).** Extrapolate the latest motion field forward 30–60 min. The tape continues past "now" as a dashed, faded section, and the future could show "rain at your place in ~25 min, heavy". Design constraint now: the motion fields from §7.4 are real data structures that stay available. Time handling must allow a playhead later than the newest frame.
- **Observations and forecast screen (user: planned, will become the main screen).** Use client-side routing from the start, e.g. `/radar`, with `/` redirecting there until the main screen exists. Write the fetcher Worker so it's easy to add more jobs, such as fetching BOM observations or forecast products, later.

## 10. Left to the builder

- Exact project structure, state management, and testing approach (follow the planning process).
- The optical-flow algorithm and its tuning (§7.4), within the constraints given.
- Exact base-map provider and style (§7.1).
- R2 key layout details, manifest schema, and how frames older than the default window load on demand.
- How the tape flick coasts (the physics), the exact lever feel and detents, and keyboard step sizes.
- Exact thresholds: how stale before warning, and how stale before switching radars.
- Visual polish: typography, button styling, the staleness indicator, the legend.
