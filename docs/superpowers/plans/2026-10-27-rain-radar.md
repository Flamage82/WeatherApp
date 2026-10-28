# Rain Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A personal rain-radar web app. It shows BOM Marburg/Mt Stapylton radar on a real map, with smooth motion between frames, a refined colour ramp, a "rain at my place" tape scrubber, and a speed lever.

**Architecture:** A single Cloudflare Worker does three jobs: (a) serves the Vite/React build as static assets, (b) answers `/api/*` from an R2 bucket, (c) runs a 1-minute cron that pulls new frames from BOM's anonymous FTP over `cloudflare:sockets` into R2. Until Task 20 it alternates radars; Task 20 moves it to one trigger per radar and at most one frame per run. The browser decodes the frames into intensity fields, estimates motion between neighbouring frames in a Web Worker, and draws interpolated frames through a MapLibre custom WebGL layer.

**Tech Stack:** TypeScript, Vite + `@cloudflare/vite-plugin`, Wrangler, Cloudflare Workers + R2 + Cron Triggers, React + react-router, MapLibre GL JS, `fast-png` (pure-JS PNG decode), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-27-rain-radar-design.md`. Read it alongside this plan; section refs like §6.2 point there.

## Global Constraints

- Home is hard-coded in one place: `HOME = { lat: -27.67217111736596, lon: 152.49661614726207 }` (`shared/config.ts`).
- Products: all eight: Marburg `IDR501–504`, Mt Stapylton `IDR661–664` (suffix 1=512 km, 2=256, 3=128, 4=64). No other products are fetched. (Task 20 dropped 501/502/661/662 on 2026-10-28; Task 21 restored them after the move to Workers Paid.)
- Data source is **FTP only**: `ftp://ftp.bom.gov.au/anon/gen/radar/` and `.../radar_transparencies/coordinates/`. Never fetch from `www.bom.gov.au` over HTTPS, and never spoof a browser User-Agent.
- Frame filenames: `IDR{nnn}.T.{YYYYMMDDHHMM}.png`, UTC. Ignore `*.png.tmp`.
- Pixels are classified by **RGB value**, never by palette index. Anything that isn't a legend colour counts as zero rain.
- Frame PNGs in R2 are **never deleted** (user, 2026-10-27). The manifest lists only the last 24 h. No loop window: playback stops at the ends and auto-stops on crossing "now" (spec §6.4). The playhead may go up to newest + 60 min (nowcast, spec §7.7). The tape scrolls back with **no 24 h limit**, as far as the archive goes (user); older stamps come from `/api/day/:product/:YYYYMMDD`.
- 1× speed = 10 min of radar time per 1 s of real time. Lever range: −4× to +4×.
- Tape span defaults to 40 min (±20 min around the fixed centre playhead), and is zoomable from 20 min to 7 days (pinch / Ctrl+wheel; double-tap resets). No snapping to frames. Above 3 h of span the tape graph uses server-recorded per-frame values (`/api/series`).
- The tape source is the active radar's sharpest range that covers home: `IDR504` (Marburg) or `IDR663` (Stapylton). It does not follow map zoom.
- An interpolated value must never exceed the higher of the two warped source values.
- Displayed times are in `Australia/Brisbane`.
- On-screen attribution: "Radar data © Commonwealth of Australia, Bureau of Meteorology" plus the base map's OSM credit.
- No auth or lock on the site.
- **Workers PAID plan (user upgraded 2026-10-28).** No CPU squeezing: one cron every minute (`* * * * *`) runs the whole ingest for both radars. No per-run frame caps, no pendingHome/due-frame scheduling.

## Review Focus

1. **Frame gaps.** BOM skips a frame or the radar goes down for 30 min. Expected: playback carries on with no smear across the gap. Pairs more than 15 min apart use a plain crossfade (zero flow). *Test in Task 7 (`locate` across a gap) and Task 8 (`computeFlow` skipped for long gaps).*
2. **UTC/local rollover.** Filename `202610271355` is 11:55 pm Brisbane on the 27th; `202610271405` is 12:05 am on the 28th. Expected: correct local time and date in the clock and tape labels. *Test in Task 1 (`stampToMs`) and Task 13 (`formatClock`).*
3. **Phone sleeps or tab is backgrounded, then resumes.** Expected: no giant time jump. Playback dt is capped at 100 ms per tick, and manifests are refetched on `visibilitychange`. *Test in Task 7 (`stepPlayback` with dt = 60 000).*
4. **Empty, missing or stale data.** An empty manifest, a 404 manifest, or both radars stale. Expected: a status message ("No radar frames yet" / "Radar data 47 min old"), never a blank screen or exception. *Test in Task 11 (`chooseRadar` when both are stale or empty) and Task 5 (API 404 for an unknown product).*
5. **Path injection on the API.** `GET /api/frame/IDR503/../../secret` or a product not in the list. Expected: 404, and no R2 read outside `frames/{knownProduct}/{12 digits}.png`. *Test in Task 5.*

---

## File Structure

```
package.json, tsconfig.json, vite.config.ts, wrangler.jsonc, vitest.config.ts, index.html, .gitignore
spikes/ftp-spike/                  Task 0 only; throwaway
shared/
  config.ts          HOME, PRODUCTS, RADARS, retention/window constants
  stamps.ts          stampToMs / msToStamp (YYYYMMDDHHMM UTC)
  legend.ts          BOM_LEGEND (rgb → level 1..15, mm/h)
  types.ts           Manifest, RadarGeometry
worker/
  index.ts           fetch + scheduled handlers
  ftp.ts             minimal passive-mode FTP client (FtpSource)
  ftpProtocol.ts     pure reply/PASV parsing
  listing.ts         filter/parse radar dir listing
  mapFile.ts         parse .map → RadarGeometry
  ingest.ts          runIngest()
  api.ts             handleApi()
src/
  main.tsx, App.tsx                  router: / → /radar
  radar/RadarScreen.tsx              composes everything
  data/api.ts                        fetchManifest/fetchFrame/fetchMeta
  (shared/decodeFrame.ts             PNG bytes → level field; browser + Worker)
  data/frameStore.ts                 window loading, live refresh
  data/chooseRadar.ts                primary/backup choice
  time/timeline.ts                   locate(), stepPlayback()
  motion/flow.ts                     computeFlow()
  motion/interpolate.ts              sampleInterpolated(), sampleInterpolatedMaxInDisc()
  motion/flow.worker.ts              Web Worker wrapper
  (shared/gnomonic.ts                lonLatToUV(), uvToLonLat(); browser + Worker)
  geo/pickRange.ts                   pickRange()
  render/colourRamp.ts               RAMP_STOPS, buildRampLUT()
  render/radarLayer.ts               MapLibre CustomLayerInterface
  render/shaders.ts                  GLSL
  tape/homeSeries.ts                 buildHomeSeries()
  tape/tapeMath.ts                   px↔time, fling decay
  tape/Tape.tsx
  controls/SpeedLever.tsx, controls/leverMath.ts
  controls/Clock.tsx, controls/formatClock.ts
  controls/PlayButton.tsx, controls/StatusBar.tsx, controls/Legend.tsx
  controls/useKeyboard.ts
```

Tests live next to their sources as `*.test.ts`. Vitest runs in the `node` environment, with `jsdom` only where a test says so.

---

### Task 0: Spike: FTP from a Worker into R2 (throwaway, go/no-go)

This settles spec §8 risk 1. It has no tests and isn't kept.

**Files:**
- Create: `.gitignore` (`node_modules/`, `dist/`, `.wrangler/`, `.superpowers/`, `.dev.vars`)
- Create: `spikes/ftp-spike/wrangler.jsonc`, `spikes/ftp-spike/index.ts`, `spikes/ftp-spike/package.json`

- [ ] **Step 1:** `git init` in `C:\src\WeatherApp`, add `.gitignore`, then commit the spec and plan (`docs: add rain radar design and plan`).
- [ ] **Step 2:** The **user** runs `npx wrangler login` (interactive browser login). Then run `npx wrangler r2 bucket create rain-radar`. Expected: "Created bucket rain-radar".
- [ ] **Step 3:** Write the spike Worker. On `GET /run` it:
  - opens `connect({hostname:"ftp.bom.gov.au", port:21})`
  - sends `USER anonymous`, `PASS anonymous@`, `TYPE I`, `PASV`
  - opens the data socket to the **control hostname** at the PASV port (ignore the IP in the PASV reply)
  - sends `NLST /anon/gen/radar/`, picks the newest `IDR503.T.*.png`, then does `PASV` + `RETR` for it
  - `put`s the file to R2 as `spike/{name}`, and returns JSON `{listed, fetched, bytes, ms}`
- [ ] **Step 4:** `npx wrangler deploy` from `spikes/ftp-spike`, then run `curl https://ftp-spike.<subdomain>.workers.dev/run`. Expected: JSON with `bytes` > 1000. `npx wrangler r2 object get rain-radar/spike/<name> --file out.png` returns a 512×512 PNG.
- [ ] **Step 5:** Run `npx wrangler tail ftp-spike` while calling `/run` 3 times and note the CPU time. Then add a `scheduled` handler that does the same, set cron `*/5 * * * *`, redeploy, and confirm in the dashboard that one cron run succeeded.
- [ ] **Step 6: Gate.**
  - **Pass** (file in R2, cron OK, CPU under free-plan limits): `npx wrangler delete` the spike Worker, delete `spike/*` objects, and continue to Task 1.
  - **CPU over the limit:** try one FTP session per run with products split across runs. If still over, **stop and ask the user** about Workers Paid.
  - **FTP fails:** **stop**. Report to the user and write a fallback plan for a Pi-hosted fetcher (spec §8). Tasks 2–4 move there; Task 5 onward is unchanged.
  - Record findings in a short note at `spikes/ftp-spike/RESULT.md` and commit it (`spike: ftp from worker result`).

---

### Task 1: Project scaffold + shared config, stamps, legend

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts` (React + `@cloudflare/vite-plugin`), `wrangler.jsonc`, `vitest.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `worker/index.ts` (stub returning 404 for `/api/*`)
- Create: `shared/config.ts`, `shared/stamps.ts`, `shared/legend.ts`, `shared/types.ts`
- Test: `shared/stamps.test.ts`, `shared/legend.test.ts`

**Interfaces:**
- Produces:
  - `HOME: {lat:number; lon:number}`
  - `type ProductId = "IDR501"|"IDR502"|"IDR503"|"IDR504"|"IDR661"|"IDR662"|"IDR663"|"IDR664"`
  - `PRODUCTS: readonly ProductId[]`
  - `RADARS: {marburg: {products: ProductId[] /* widest→sharpest */, tapeProduct:"IDR504"}, stapylton: {products: ProductId[], tapeProduct:"IDR663"}}`
  - `MANIFEST_SPAN_MS = 86_400_000`, `DEFAULT_WINDOW_MS = 7_200_000`, `MAX_FLOW_GAP_MS = 900_000`
  - `stampToMs(s: string): number`, `msToStamp(ms: number): string`
  - `BOM_LEGEND: {rgb:number /*0xRRGGBB*/; level:number /*1..15*/; mmh:number}[]`
  - `rgbToLevel(r:number,g:number,b:number): number` (0 if not in the legend)
  - `type Manifest = {product: ProductId; frames: string[] /* ascending stamps */; lastFetchOk: string|null /* ISO */; lastError: string|null}`
  - `type RadarGeometry = {product: ProductId; name: string; centre:{lat:number;lon:number}; corners: {bl:LonLat; tl:LonLat; tr:LonLat; br:LonLat}}`, with `LonLat = {lon:number; lat:number}`

- [ ] **Step 1: Scaffold.** Run `npm init -y`. Install `react react-dom react-router maplibre-gl fast-png`. Install dev deps `typescript vite @vitejs/plugin-react @cloudflare/vite-plugin wrangler vitest jsdom @types/react @types/react-dom @cloudflare/workers-types`. Set up `wrangler.jsonc`:
  - `name: "rain-radar"`, `main: "worker/index.ts"`, `compatibility_date`: today
  - `assets: { not_found_handling: "single-page-application", run_worker_first: ["/api/*"] }`
  - `r2_buckets: [{binding:"BUCKET", bucket_name:"rain-radar"}]`
  - `triggers: { crons: ["* * * * *"] }` (every minute; see Task 5 for radar alternation)

  Scripts: `dev` = `vite`, `build` = `vite build`, `test` = `vitest run`, `deploy` = `npm run build && wrangler deploy`.
- [ ] **Step 2: Write failing tests.**
```ts
// shared/stamps.test.ts
expect(stampToMs("202610271355")).toBe(Date.UTC(2026, 9, 27, 13, 55));
expect(msToStamp(Date.UTC(2026, 9, 28, 0, 5))).toBe("202610280005");
expect(() => stampToMs("20261027135")).toThrow();
// shared/legend.test.ts
expect(rgbToLevel(0xf5,0xf5,0xff)).toBe(1);
expect(rgbToLevel(0x28,0x00,0x00)).toBe(15);
expect(rgbToLevel(0,0,0)).toBe(0);          // banner text
expect(rgbToLevel(0xc0,0xc0,0xc0)).toBe(0); // grey text
expect(BOM_LEGEND.map(e => e.level)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
```
- [ ] **Step 3:** Run `npx vitest run shared`. Expected: FAIL, modules missing.
- [ ] **Step 4: Verify the legend before coding it.** Run `curl --list-only ftp://ftp.bom.gov.au/anon/gen/radar_transparencies/ | grep -i legend`, download the legend PNG(s), and read the palette with a short `python -I` script printing PLTE entries. Then download 5 recent frames from a rainy radar and confirm every non-text RGB in them appears in the legend. Use the spec §4.1 table, corrected to whatever BOM's legend actually shows. Record any differences in a comment in `legend.ts`.
- [ ] **Step 5:** Implement `shared/*`. Run `npx vitest run shared`. Expected: PASS.
- [ ] **Step 6:** Run `npm run dev`. Expected: the Vite page renders "Rain radar" at `/radar`, and `/` redirects to `/radar`.
- [ ] **Step 7:** Commit (`feat: scaffold app, shared config, stamps, BOM legend`).

---

### Task 2: FTP client for Workers

**Files:**
- Create: `worker/ftpProtocol.ts`, `worker/ftp.ts`
- Test: `worker/ftpProtocol.test.ts`

**Interfaces:**
- Produces:
  - `interface FtpSource { list(pathOrGlob:string): Promise<string[]>; retrieve(path:string): Promise<Uint8Array>; close(): Promise<void> }`. `list` sends `NLST <pathOrGlob>`. The server supports vsftpd globs, e.g. `/anon/gen/radar/IDR503.T.*.png`; **never NLST the whole radar directory** (~417 KB, 13–19 ms CPU).
  - `openBomFtp(): Promise<FtpSource>` (in `ftp.ts`, uses `cloudflare:sockets`)
  - `parsePasv(line:string): {port:number}`
  - `class ReplyReader { constructor(readable: ReadableStream<Uint8Array>); next(): Promise<{code:number; text:string}> }` handles multi-line `123-…` / `123 …` replies.

- [ ] **Step 1: Write failing tests.**
```ts
expect(parsePasv("227 Entering Passive Mode (134,178,253,145,195,80).")).toEqual({port: 195*256+80});
expect(() => parsePasv("500 nope")).toThrow();
// ReplyReader over a ReadableStream built from chunks split mid-line:
// chunks ["220-Welcome\r\n220-to BOM\r", "\n220 ready\r\n331 Send pass\r\n"]
// next() → {code:220, text:"Welcome\nto BOM\nready"}; next() → {code:331, text:"Send pass"}
```
- [ ] **Step 2:** Run `npx vitest run worker/ftpProtocol`. Expected: FAIL.
- [ ] **Step 3:** Implement `ftpProtocol.ts`, then `ftp.ts`, porting the spike's working sequence. Its quirks are in `spikes/ftp-spike/RESULT.md` and `spikes/ftp-spike/index.ts`; read both first. The data connection goes to the control hostname, not the PASV IP. Each transfer gets a fresh PASV, and the data socket is opened and read before NLST/RETR is sent. QUIT is fire-and-forget. Logging is minimal, because it costs CPU. Every command expects a specific reply class and throws `Error("FTP <cmd>: <code> <text>")` otherwise. `list` uses `NLST` and returns basenames.
- [ ] **Step 4:** Run `npx vitest run worker`. Expected: PASS.
- [ ] **Step 5:** Commit (`feat: minimal passive FTP client for workers`).

---

### Task 3: Listing filter + `.map` parser

**Files:**
- Create: `worker/listing.ts`, `worker/mapFile.ts`
- Test: `worker/listing.test.ts`, `worker/mapFile.test.ts`

**Interfaces:**
- Consumes: `PRODUCTS`, `RadarGeometry` (Task 1)
- Produces:
  - `parseListing(names:string[]): Map<ProductId, string[] /* ascending stamps */>`
  - `parseMapFile(text:string): RadarGeometry`

- [ ] **Step 1: Write failing tests.**
```ts
const m = parseListing(["IDR503.T.202610270549.png","IDR503.T.202610270544.png",
  "IDR712.T.202110092349.png.tmp","IDR503.T.202610270554.png.tmp","IDR713.T.202610270549.png","IDR503.gif"]);
expect(m.get("IDR503")).toEqual(["202610270544","202610270549"]);
expect([...m.keys()]).toEqual(["IDR503"]);
// mapFile: use the IDR503 text from spec §4.1 verbatim as a fixture
expect(g.centre).toEqual({lat:-27.608, lon:152.539});
expect(g.corners.bl).toEqual({lon:151.23309, lat:-28.74816});
expect(g.corners.tr).toEqual({lon:153.82970, lat:-26.44766});
expect(g.name).toBe("Marburg (128 km)");
```
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Corners map as `lon0/lat0`=bl, `lon1/lat1`=tl, `lon2/lat2`=tr, `lon3/lat3`=br. Throw if `projection` isn't `Gnomonic`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit (`feat: parse BOM radar listing and map files`).

---

### Task 4: Ingest job

**Files:**
- Create: `worker/ingest.ts`
- Test: `worker/ingest.test.ts` (uses a fake `FtpSource` and an in-memory bucket implementing `get/put/delete/list` over a `Map`)

**Interfaces:**
- Consumes: `FtpSource`, `parseListing`, `parseMapFile`, `PRODUCTS`, `MANIFEST_SPAN_MS`, `Manifest`
- Produces:
  - `type BucketLike = Pick<R2Bucket, "get"|"put"|"delete">`
  - `runIngest(deps:{ftp:FtpSource; bucket:BucketLike; nowMs:number; products:ProductId[]; maxDownloads?:number /* default 6 */}): Promise<IngestReport>`. It lists each product with its own glob `/anon/gen/radar/{product}.T.*.png` and downloads at most `maxDownloads` new frames per run, newest first, so the initial fill spreads over several runs.
  - `type IngestReport = {added: Record<ProductId, number>; droppedFromManifest: number; errors: string[]}`
  - R2 keys: `frames/{product}/{stamp}.png`, `manifest/{product}.json`, `meta/{product}.json` (a `RadarGeometry` plus `fetchedAt` ISO)

- [ ] **Step 1: Write failing tests.**
  - `downloads only new frames`: the manifest already has `"202610270544"` and the listing has `544, 549`. Expected: 1 `retrieve` call, the manifest frames are `[544, 549]`, and `lastFetchOk` is the ISO of `nowMs`.
  - `drops stamps older than 24h from the manifest but never deletes frames`: the manifest has a stamp 25 h before `nowMs`. Expected: the stamp is gone from the manifest, `bucket.delete` is **never** called, and the frame object is still in the bucket.
  - `one product failing does not stop the others`: `retrieve` throws for IDR504. Expected: IDR503 is still updated, IDR504's manifest `lastError` contains the message and keeps the old `lastFetchOk`, and `report.errors.length === 1`.
  - `fetches meta when missing or older than 7 days, else skips`: count `retrieve` calls for `/anon/gen/radar_transparencies/coordinates/IDR503.map`.
  - `idempotent`: running twice with the same listing makes no extra `put` of frames.
- [ ] **Step 2:** Run `npx vitest run worker/ingest`. Expected: FAIL.
  - `caps downloads per run`: 20 new stamps listed, `maxDownloads: 6`. Expected: exactly the 6 newest are retrieved, and a second run fetches the next 6.
  - `only touches the given products`: `products: ["IDR503"]`. Expected: no `list`/`retrieve` for anything else.
- [ ] **Step 3:** Implement. Use one glob `list` per product, sequential downloads, and write the manifest last for each product.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit (`feat: ingest new BOM frames into R2`).

---

### Task 5: API routes + scheduled wiring + first deploy

**Files:**
- Create: `worker/api.ts`
- Modify: `worker/index.ts`
- Test: `worker/api.test.ts`

**Interfaces:**
- Consumes: `BucketLike`, `PRODUCTS`, `RADARS`, `runIngest`, `openBomFtp`
- Produces (HTTP):
  - `GET /api/manifest/:product` → `Manifest` JSON, `Cache-Control: public, max-age=30`
  - `GET /api/frame/:product/:stamp` → `image/png`, `Cache-Control: public, max-age=31536000, immutable`
  - `GET /api/meta/:product` → `RadarGeometry` JSON, `max-age=86400`
  - `GET /api/day/:product/:day` (`day` = `YYYYMMDD`, UTC) → `{product, day, frames: string[] /* ascending stamps */}`, built from `bucket.list({prefix:"frames/{product}/{day}"})` following `cursor` until `truncated` is false. `Cache-Control`: `public, max-age=31536000, immutable` for days before today (UTC), `max-age=60` for today, and 404 for future days.
  - `type ApiBucket = Pick<R2Bucket, "get"|"list">`
  - `handleApi(req:Request, bucket:ApiBucket, nowMs:number): Promise<Response>`

- [ ] **Step 1: Write failing tests.**
  - The manifest for a known product returns 200 JSON with the correct cache header.
  - The frame route returns PNG bytes and the immutable header.
  - The day route with 3 frames for `20261026` in the fake bucket (plus one for `20261027` and one for another product) returns exactly those 3, ascending, with the immutable header when `nowMs` is on the 27th. The same request on the 26th itself gets `max-age=60`. A day after `nowMs` returns 404.
  - The day route pages: a fake `list` returning 2 pages (`truncated:true` + `cursor`) is merged.
  - Each of these returns 404 **and makes no `bucket.get` or `bucket.list` call**: `/api/frame/IDR999/202610270549`, `/api/frame/IDR503/..%2F..%2Fx`, `/api/frame/IDR503/2026`, `/api/manifest/IDR503x`, `/api/day/IDR503/2026102`, `/api/day/IDR503/..%2F`.
  - An object missing from R2 returns 404.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `handleApi` with strict matching: product ∈ `PRODUCTS`, stamp `/^\d{12}$/`, day `/^\d{8}$/`. Wire `worker/index.ts`: `fetch` sends `/api/*` → `handleApi(req, env.BUCKET, Date.now())`; `scheduled` picks `RADARS.marburg.products` on even UTC minutes and `RADARS.stapylton.products` on odd ones (from `event.scheduledTime`), then runs `ctx.waitUntil(runIngest({ftp: await openBomFtp(), bucket: env.BUCKET, nowMs: Date.now(), products}))`. It always closes the FTP connection. Add a unit test for the minute → radar choice: export `productsForMinute(scheduledTimeMs:number): ProductId[]` from `worker/index.ts`.
- [ ] **Step 4:** Run `npm test`. Expected: all PASS.
- [ ] **Step 5:** Run `npm run deploy`. Wait 10 min. Run `npx wrangler tail rain-radar --format json` over ≥ 6 cron runs and record `cpuTime`. If any run exceeds 10 ms after the first fill, lower `maxDownloads` to 3 and recheck. If it's still over, **stop and ask the user** (Workers Paid decision). Then run `curl https://rain-radar.<subdomain>.workers.dev/api/manifest/IDR503`. Expected: `frames.length >= 2` and `lastError: null`. Download one frame URL and confirm it's a PNG.
- [ ] **Step 6:** Commit (`feat: radar API and cron ingest`).

---

### Task 6: Frame decoding + API client (browser)

**Files:**
- Create: `shared/decodeFrame.ts` (in `shared/` because the Worker also uses it, in Task 15), `src/data/api.ts`
- Test: `shared/decodeFrame.test.ts` (fixture: 1 real frame with rain as `shared/__fixtures__/IDR503-sample.png`, plus a tiny synthetic PNG encoded in-test with `fast-png`'s `encode`. BOM frames come as both 4-bit and 8-bit palettes, so cover both.)

**Interfaces:**
- Consumes: `rgbToLevel`, `Manifest`, `RadarGeometry`, `ProductId`
- Produces:
  - `type LevelField = {width:512; height:512; data: Uint8Array /* level 0..15, row 0 = top */}`
  - `decodeFrame(png: Uint8Array): LevelField` (palette PNG → RGB via PLTE → `rgbToLevel`; tRNS-transparent → 0)
  - `fetchManifest(p:ProductId): Promise<Manifest>`, `fetchFrame(p:ProductId, stamp:string): Promise<Uint8Array>`, `fetchMeta(p:ProductId): Promise<RadarGeometry>`, `fetchDay(p:ProductId, day:string /* YYYYMMDD UTC */): Promise<string[]>` (returns `[]` on 404)

- [ ] **Step 1: Write failing tests.**
  - Synthetic 4×4 indexed PNG with palette `[transparent, #000000, #f5f5ff, #280000]` → data `[0,0,1,15,…]` as laid out.
  - Same pixels but a **different palette order** → identical levels.
  - Real fixture: the top 16 rows (banner) and bottom 20 rows (label) are all 0, and at least one pixel is > 0.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Use `fast-png` `decode`, then expand indices with `palette`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit (`feat: decode BOM frames to intensity levels`).

---

### Task 7: Timeline + playback model

**Files:**
- Create: `src/time/timeline.ts`
- Test: `src/time/timeline.test.ts`

**Interfaces:**
- Consumes: `MAX_FLOW_GAP_MS`, `DEFAULT_WINDOW_MS`
- Produces:
  - `locate(frames:number[] /* ascending ms */, t:number): {i:number; alpha:number; gapMs:number}` (clamps to `[frames[0], frames.at(-1)]`; `i` = index of the earlier frame; `alpha` ∈ [0,1])
  - `type PlayState = {t:number; speed:number /* −4..4, 0 = paused */; lastSpeed:number; holdMs:number}`
  - `stepPlayback(s:PlayState, dtMs:number, win:{start:number; end:number}): PlayState`
  - `loopWindow(t:number, newestMs:number, spanMs = DEFAULT_WINDOW_MS): {start:number; end:number}` (a window of length `spanMs` centred on `t`, shifted back so `end ≤ newestMs`)
  - `SPEED_SCALE = 600` (radar-ms per real-ms at 1×)

- [ ] **Step 1: Write failing tests.**
```ts
const F = [0, 300_000, 600_000, 2_400_000]; // last gap is 30 min
expect(locate(F, 450_000)).toEqual({i:1, alpha:0.5, gapMs:300_000});
expect(locate(F, -5)).toEqual({i:0, alpha:0, gapMs:300_000});
expect(locate(F, 9e9).alpha).toBe(1);
expect(locate(F, 1_500_000)).toMatchObject({i:2, gapMs:1_800_000});
// 1× for 100 ms advances 60 000 radar-ms (1 min)
expect(stepPlayback({t:0,speed:1,lastSpeed:1,holdMs:0}, 100, {start:0,end:7.2e6}).t).toBe(60_000);
// dt clamp: a 60 s tick behaves like 100 ms
expect(stepPlayback({t:0,speed:1,lastSpeed:1,holdMs:0}, 60_000, {start:0,end:7.2e6}).t).toBe(60_000);
// hitting the end: clamps to end, holds 1000 ms, then wraps to start
// reverse at start: holds, then wraps to end
const H = 3_600_000, N = 100 * H;
expect(loopWindow(N, N)).toEqual({start: N - 2*H, end: N});               // at now → last 2 h
expect(loopWindow(N - 0.5*H, N)).toEqual({start: N - 2*H, end: N});       // near now → still last 2 h
expect(loopWindow(N - 30*H, N)).toEqual({start: N - 31*H, end: N - 29*H}); // scrolled back → centred
```
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. dt is clamped to 100 ms before scaling.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit (`feat: timeline locate and playback stepping`).

---

### Task 8: Motion estimation + interpolation

**Files:**
- Create: `src/motion/flow.ts`, `src/motion/interpolate.ts`, `src/motion/flow.worker.ts`
- Test: `src/motion/flow.test.ts`, `src/motion/interpolate.test.ts`

**Interfaces:**
- Consumes: `LevelField`, `MAX_FLOW_GAP_MS`
- Produces:
  - `type FlowField = {gw:number; gh:number; data: Float32Array /* (dx,dy) pairs in full-res px, A→B, on a gw×gh grid spanning the frame */}`
  - `computeFlow(a:LevelField, b:LevelField): FlowField`
  - `ZERO_FLOW: FlowField` (a 1×1 grid holding (0,0))
  - `flowAt(f:FlowField, x:number, y:number): [number, number]` (bilinear)
  - `sampleInterpolated(a, b, f, alpha, x, y): number` (float level)
  - `sampleInterpolatedMaxInDisc(a, b, f, alpha, cx, cy, rPx): number`
  - The worker gets `{id, a:Uint8Array, b:Uint8Array, gapMs}` and replies `{id, flow:FlowField}` (`ZERO_FLOW` when `gapMs > MAX_FLOW_GAP_MS`).

**Algorithm (`computeFlow`; the spec leaves the choice to the builder, and this plan fixes it):**
```
1. Downsample A and B ×4 by mean → 128×128 float.
2. Block matching on the 128² images: blocks 8×8, stride 4 → 31×31 grid.
   Search ±8 px (= ±32 full-res px), minimise SAD.
   Skip a block (mark invalid) if fewer than 6 of its pixels are > 0 in A.
3. Invalid vectors: fill with the weighted mean of valid vectors within 3 cells (weight = 1/d²).
   If none are valid anywhere → all zero.
4. 3×3 median filter on each component, then one 3×3 box blur.
5. Scale vectors ×4 to full-res px; gw = gh = 31.
```
Interpolation at α for output pixel p: `wa = A(p − α·F(p))`, `wb = B(p + (1−α)·F(p))` (bilinear samples), result `= min((1−α)·wa + α·wb, max(wa, wb))`.

- [ ] **Step 1: Write failing tests.** Fixtures are synthetic: a disc of radius 20 px with level 10 at (200,200) in A and at (216,208) in B.
  - `computeFlow` near the disc ≈ (16, 8) ± 1.5 px.
  - Identical A and B → all vectors |v| < 0.5.
  - Empty frames → all zero.
  - `sampleInterpolated(…, 0.5, 208, 204)` ≈ 10 (the disc is halfway).
  - `sampleInterpolated(…, 0.5, 184, 204)` < 2, where a plain crossfade would give 5. That shows the disc moved rather than fading in place.
  - **No inventing:** for a 64×64 grid of points and α ∈ {0.25, 0.5, 0.75}, the result ≤ max(wa, wb).
  - **New cell:** a disc appears in B only → at α=0.5 the value at its centre ≈ 5 (a crossfade, not a smear).
  - `sampleInterpolatedMaxInDisc` returns the maximum value over the disc.
  - Performance: `computeFlow` on 512² fields takes < 150 ms in Node (log it, assert < 500).
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `flow.ts`, `interpolate.ts`, then the worker wrapper (transfer buffers).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit (`feat: radar motion estimation and interpolation`).

---

### Task 9: Gnomonic projection + range picking

**Files:**
- Create: `shared/gnomonic.ts` (in `shared/` because the Worker also uses it, in Task 15), `src/geo/pickRange.ts`
- Test: `shared/gnomonic.test.ts`, `src/geo/pickRange.test.ts`

**Interfaces:**
- Consumes: `RadarGeometry`, `RADARS`
- Produces:
  - `lonLatToUV(g:RadarGeometry, lon:number, lat:number): {u:number; v:number}` (u right, v down, 0..1 over the image)
  - `uvToLonLat(g, u, v): LonLat`
  - `frameBounds(g): {west:number; south:number; east:number; north:number}`
  - `pickRange(view:{west:number;south:number;east:number;north:number}, geoms:RadarGeometry[] /* widest→sharpest */): ProductId`

Math: forward gnomonic about the centre (φ0, λ0): `cos c = sinφ0 sinφ + cosφ0 cosφ cos(λ−λ0)`, `x = cosφ sin(λ−λ0)/cos c`, `y = (cosφ0 sinφ − sinφ0 cosφ cos(λ−λ0))/cos c`. The image extent is the min/max of the four projected corners, and u, v are linear in x, y with v flipped.

- [ ] **Step 1: Write failing tests** (IDR503 fixture from Task 3):
  - Corners map to bl→(0,1), tl→(0,0), tr→(1,0), br→(1,1), each ±0.002.
  - Centre → (0.5, 0.5) ± 0.002.
  - `uvToLonLat(lonLatToUV(HOME))` round-trips HOME to within 1e-6°.
  - HOME in the IDR504 geometry is within u, v ∈ (0.4, 0.6) (it's 8 km from the centre).
  - `pickRange` with a view of ±0.1° around HOME → `"IDR504"`. A view covering −30..−25, 150..155 → `"IDR501"` or `"IDR502"`, whichever is the sharpest that contains it.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Step 1 needs real `.map` fixtures for IDR501/502/504, so fetch them over FTP with curl into `shared/__fixtures__/`. `worker/__fixtures__/IDR503.map` already exists from Task 3.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit (`feat: gnomonic projection and range picking`).

---

### Task 10: Colour ramp + radar WebGL layer + map screen

**Files:**
- Create: `src/render/colourRamp.ts`, `src/render/shaders.ts`, `src/render/radarLayer.ts`, `src/radar/RadarScreen.tsx`
- Modify: `src/App.tsx`
- Test: `src/render/colourRamp.test.ts`

**Interfaces:**
- Consumes: `LevelField`, `FlowField`, `RadarGeometry`, `frameBounds`, `HOME`
- Produces:
  - `RAMP_STOPS: {level:number; rgb:string; alpha:number}[]` from spec §7.2 (`#81d4fa` at level 1 with alpha 0.35, `#29b6f6` at 3 with alpha 0.75, `#43a047` at 5, `#fdd835` at 8, `#fb8c00` at 10, `#e53935` at 12, `#d81b9a` at 15; alpha 1 from level 5 up)
  - `buildRampLUT(): Uint8Array /* 256×RGBA, index = round(level/15·255) */`
  - `rampColour(level:number): [r,g,b,a]` (same as the LUT; used by the tape)
  - `class RadarLayer implements maplibregl.CustomLayerInterface` with `setGeometry(g)`, `setPair(a:LevelField, b:LevelField, flow:FlowField, alpha:number)`, `setCrossfade(other:RadarLayer|null, mix:number)` (for range changes)

- [ ] **Step 1: Write failing tests:** `rampColour(0)[3] === 0`; `rampColour(15)` equals `#d81b9a` at alpha 255; colours increase monotonically in "heat" (pin exact values at each stop); and the LUT at level 1 has alpha ≈ 89.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the ramp and the layer:
  - Upload levels as `R8` textures with LINEAR filtering, and flow as an `RG16F` texture with LINEAR filtering (filterable in WebGL2 without extensions).
  - The vertex shader draws the `frameBounds` quad in Mercator.
  - The fragment shader goes Mercator → lon/lat → gnomonic uv, applies the warp-and-blend from Task 8 identically, then a LUT lookup.
  - Discard outside 0..1 uv.
- [ ] **Step 4:** In `RadarScreen`, set up a MapLibre map:
  - Style `https://tiles.openfreemap.org/styles/positron` in light mode and its dark style in dark mode. First check with `curl -I` that the dark style URL returns 200; if not, use positron with background/land paint darkened in code.
  - Centre on HOME, zoom 9.
  - A home pin as a MapLibre `Marker`.
  - One `RadarLayer` fed by hard-wired fetches of the latest two IDR503 frames with α driven by a temporary range slider.
- [ ] **Step 5: Verify visually.** Run `npm run dev`. With Playwright, take screenshots at α=0, 0.5 and 1 on a rainy day, or with frames from any rainy radar swapped in temporarily. Expected: rain sits correctly over the coastline/roads (compare with BOM's own image for the same time), the colours match the ramp, and α=0.5 shows cells halfway along with no double image.
- [ ] **Step 6:** Commit (`feat: radar webgl layer with ramp and map`).

---

### Task 11: Frame store, radar choice, live refresh

**Files:**
- Create: `src/data/chooseRadar.ts`, `src/data/frameStore.ts`
- Modify: `src/radar/RadarScreen.tsx` (remove the temporary slider wiring)
- Test: `src/data/chooseRadar.test.ts`, `src/data/frameStore.test.ts`

**Interfaces:**
- Consumes: `fetchManifest/fetchFrame/fetchMeta/fetchDay`, `decodeFrame`, the flow worker, `locate`, `pickRange` (used by RadarScreen), `RADARS`, `DEFAULT_WINDOW_MS`, `MANIFEST_SPAN_MS`, `stampToMs`, `msToStamp`
- Produces:
  - `STALE_SWITCH_MS = 1_200_000`, `STALE_WARN_MS = 900_000`, `DECODED_CAP_MS = 21_600_000` (6 h of decoded frames + flows per product)
  - `chooseRadar(m:{marburg:Manifest|null; stapylton:Manifest|null}, nowMs:number): {radar:"marburg"|"stapylton"; status:"ok"|"stale"|"empty"; newestMs:number|null}`
  - `class FrameStore extends EventTarget` with `constructor(deps:{api; decode; flow:(a,b,gapMs)=>Promise<FlowField>; now:()=>number})`, `start(): Promise<void>`, `refresh(): Promise<void>`, `ensureProduct(p:ProductId): void`, `extendBack(toMs:number): void` (for every loaded product it learns the stamps back to `toMs`: from the manifest within 24 h, and beyond that with `fetchDay` per UTC day, each day fetched once and cached; then it loads those frames), `ensureAround(t:number): void` (keeps decoded frames and flows within `DECODED_CAP_MS` centred on `t`, evicting the furthest; re-fetching an evicted frame hits the browser HTTP cache), `getPair(p:ProductId, t:number): {a:LevelField; b:LevelField; flow:FlowField; alpha:number} | null` (null if that pair isn't decoded yet), `frames(p): number[]` (all known stamps, as ms), and `loadedWindow(): {start:number; end:number}` (the earliest known stamp to the newest). It dispatches `"change"`.

- [ ] **Step 1: Write failing tests.**
  - `chooseRadar`:
    - Marburg newest 5 min old → marburg/ok.
    - Marburg 25 min old and Stapylton 5 min → stapylton/ok.
    - Both 40 min old → marburg/stale.
    - Both empty or null → marburg/empty with `newestMs: null`.
  - `FrameStore` (fake deps):
    - `start()` loads the tape product and IDR503 for the last 2 h only.
    - `refresh()` with one new stamp fetches only that frame and computes one new flow.
    - Frames are decoded once and cached.
    - `getPair` returns null when there are fewer than 2 frames.
    - `extendBack(newest − 4 h)` fetches only the frames between 4 h and 2 h back, and `loadedWindow().start` moves back to match.
    - `extendBack(newest − 30 h)` calls `fetchDay` for the UTC day(s) not covered by the manifest, exactly once each even if called twice, and merges their stamps in order with no duplicates.
    - `ensureAround(t)` after loading 10 h of frames leaves at most 6 h (+1 frame) decoded, all within ±3 h of `t`. `getPair` far from `t` returns null until `ensureAround` moves there.
    - A `fetchDay` returning `[]` (before the archive began) stops further `extendBack` calls from requesting earlier days, and `loadedWindow().start` stays at the earliest real frame.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement:
  - Refresh every 60 s and on `visibilitychange` → visible.
  - When the radar changes, the whole store switches (never mix radars).
  - `ensureProduct` lazy-loads other ranges.
  - `RadarScreen` calls `pickRange` on `moveend`, then crossfades layers over 300 ms when the product changes.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then run `npm run dev`. Expected: zooming in or out switches ranges with a crossfade, and nothing reloads while panning.
- [ ] **Step 5:** Commit (`feat: frame store with radar fallback and live refresh`).

---

### Task 12: The tape

**Files:**
- Create: `src/tape/homeSeries.ts`, `src/tape/tapeMath.ts`, `src/tape/Tape.tsx`
- Modify: `src/data/api.ts` (add `fetchSeries`)
- Test: `src/tape/homeSeries.test.ts`, `src/tape/tapeMath.test.ts`

**Interfaces:**
- Consumes: `FrameStore.getPair`, `sampleInterpolatedMaxInDisc`, `homePixel` (Task 15), `HOME`, `rampColour`, `SeriesDay` (Task 15)
- Produces:
  - `DEFAULT_SPAN_MS = 2_400_000`, `MIN_SPAN_MS = 1_200_000`, `MAX_SPAN_MS = 604_800_000`, `SERIES_SOURCE_SWITCH_MS = 10_800_000`, `SERIES_STEP_MS = 30_000`
  - `buildHomeSeries(store, product, geom, fromMs, toMs): Float32Array /* interpolated level per 30 s step; NaN where no decoded pair */` (used when span ≤ `SERIES_SOURCE_SWITCH_MS`)
  - `fetchSeries(p:ProductId, day:string): Promise<SeriesDay>` in `src/data/api.ts` (`{points: []}` on 404)
  - `seriesToColumns(points:[stamp:string, level:number][], fromMs, toMs, columns:number): Float32Array` (per-pixel-column level for span > `SERIES_SOURCE_SWITCH_MS`: the max of the points inside the column. A column with no point inside takes the nearest point's level if it's within 10 min of the column centre; otherwise NaN.)
  - `pxToMs(dxPx:number, widthPx:number, spanMs:number): number` = `dxPx / widthPx * spanMs` (dragging right goes back in time: the caller negates the sign)
  - `zoomSpan(spanMs:number, scale:number): number` (`spanMs / scale`, clamped to [MIN_SPAN_MS, MAX_SPAN_MS]; a pinch spreading 2× gives scale 2)
  - `tickStepMs(spanMs:number): number` (the first of [10 min, 30 min, 1 h, 3 h, 6 h, 12 h, 1 day] giving ≤ 6 labels across the span)
  - `flingStep(v:number /* ms per ms */, dtMs:number): number` (exponential friction, half-life 250 ms; returns 0 below 0.05 × (spanMs / DEFAULT_SPAN_MS), so the caller passes a span-scaled threshold)
  - `<Tape t, spanMs, frames, onScrub(tMs), onSpanChange(spanMs) />`

- [ ] **Step 1: Write failing tests.**
  - `buildHomeSeries` with a fake store whose A has the level-10 disc on HOME's pixel and an empty B with zero flow: the first sample is 10, the middle sample is 5, the last is 0, and the length is `(to−from)/30000 + 1`.
  - Outside the frame range → NaN.
  - `pxToMs(100, 400, DEFAULT_SPAN_MS) === 600_000`; `pxToMs(100, 400, 86_400_000) === 21_600_000`.
  - `zoomSpan(2_400_000, 2) === 1_200_000`; `zoomSpan(1_200_000, 2) === 1_200_000` (clamped); `zoomSpan(604_800_000, 0.5) === 604_800_000`.
  - `tickStepMs(2_400_000) === 600_000`; `tickStepMs(86_400_000) === 21_600_000`; `tickStepMs(604_800_000) === 86_400_000`.
  - `seriesToColumns` with points at 00:00 = 3, 00:05 = 9, 00:10 = 2 over 00:00–00:10 in 2 columns → `[3, 9]`. Columns are half-open `[start, end)`, except the last also includes `toMs`. With points only at 00:00 and 00:10 over 20 columns, no column is NaN. A column 3 h from any point → NaN.
  - `flingStep(1, 250) ≈ 0.5`; `flingStep(0.04, 16) === 0`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `Tape.tsx`:
  - A 64 px canvas with the playhead fixed at the centre and the graph filled with `rampColour` per column.
  - Time labels every `tickStepMs(spanMs)` in Brisbane time. Show the date (e.g. "Tue 27") at midnight ticks and whenever the step is ≥ 6 h.
  - Pointer events with `setPointerCapture`, plus `touch-action: none`, so the map never sees tape drags.
  - On release, velocity comes from the last 80 ms of moves, then a `flingStep` loop runs on rAF.
  - A wheel or horizontal trackpad scroll over the tape scrubs too.
  - **Zoom:** two pointers on the tape = pinch, where the scale is the ratio of their horizontal distances, passed through `zoomSpan`. Ctrl/⌘ + wheel zooms by `scale = exp(−deltaY/300)`. Zoom stays centred on the playhead. Double-tap or double-click resets to `DEFAULT_SPAN_MS`. Call `e.preventDefault()` on ctrl-wheel so the browser doesn't zoom the page.
  - **Series source:** span ≤ `SERIES_SOURCE_SWITCH_MS` → `buildHomeSeries` (recomputed only when frames change; scrubbing doesn't recompute it). Above that → `seriesToColumns` over `fetchSeries` day files for the visible UTC days, each day fetched once and cached; today's file is refetched on `refresh`.
  - When the playhead comes within 20 min of `loadedWindow().start`, call `store.extendBack(start − 1 h)`. There is no lower limit apart from the start of the archive (spec §6.4). Call `store.ensureAround(t)` as the playhead moves, throttled to once per 500 ms.
  - Where pairs aren't decoded yet (just loaded, far back), the series is NaN and the tape shows a faint "loading" hatch. The map keeps the last drawn pair until the new one arrives, so it never goes blank.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then run `npm run dev` with Playwright mobile emulation. Expected:
  - The drag moves the map's time, a flick coasts, and the graph peak lines up with rain passing the home pin.
  - Pinch or Ctrl+wheel zooms between 20 min and 7 days, the labels change step, and the graph switches to the per-frame series above 3 h without the tape jumping.
  - Double-tap resets the span.
- [ ] **Step 5:** Commit (`feat: rain-at-home tape scrubber`).

---

### Task 13: Speed lever, play button, clock, keyboard, status, legend

**Files:**
- Create: `src/controls/leverMath.ts`, `src/controls/SpeedLever.tsx`, `src/controls/PlayButton.tsx`, `src/controls/formatClock.ts`, `src/controls/Clock.tsx`, `src/controls/StatusBar.tsx`, `src/controls/Legend.tsx`, `src/controls/useKeyboard.ts`
- Modify: `src/radar/RadarScreen.tsx` (a rAF loop calls `stepPlayback(state, dt, win)` and pushes `getPair` to the layer. `win = loopWindow(t, newestMs)` is computed when Play is pressed and again when the user scrubs while playing. New frames arriving extend `win.end` only if `win.end` was the newest frame.)
- Test: `src/controls/leverMath.test.ts`, `src/controls/formatClock.test.ts`

**Interfaces:**
- Consumes: `PlayState`, `stepPlayback`, `loopWindow`, `chooseRadar` status
- Produces:
  - `leverToSpeed(pos:number /* 0 bottom … 1 top */): number` (linear −4..4, with detents: snaps to 0, ±1, ±2, ±4 within ±0.15 speed)
  - `speedToLever(speed:number): number`
  - `formatClock(tMs:number, nowMs:number): {time:string; rel:string}`. `time` uses `Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',hour:'numeric',minute:'2-digit',hour12:true})`, lower-cased, e.g. "4:35 pm". `rel` is "now" if |t−now| < 60 s, else `−N min` (N = rounded minutes; `−1 h 05 min` from 60 min up).

- [ ] **Step 1: Write failing tests.**
```ts
expect(leverToSpeed(0.5)).toBe(0); expect(leverToSpeed(1)).toBe(4); expect(leverToSpeed(0)).toBe(-4);
expect(leverToSpeed(0.5 + 1.08/8)).toBe(1);            // within detent of 1×
expect(speedToLever(2)).toBeCloseTo(0.75);
const now = Date.UTC(2026,9,27,14,10);
expect(formatClock(Date.UTC(2026,9,27,13,55), now)).toEqual({time:"11:55 pm", rel:"−15 min"});
expect(formatClock(Date.UTC(2026,9,27,14,5), now).time).toBe("12:05 am");
expect(formatClock(now - 30_000, now).rel).toBe("now");
expect(formatClock(now - 65*60_000, now).rel).toBe("−1 h 05 min");
```
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the components:
  - **Lever:** vertical, on the right, pointer-captured, and it stays where it's left.
  - **Play button:** toggles `speed` between 0 and `lastSpeed`, with a default `lastSpeed` of 1.
  - **Keyboard:** Space = play/pause; ←/→ = ∓5 min (Shift = ∓1 min); `[` / `]` = speed ∓1 step through the detents.
  - **StatusBar:** "updated N min ago", a warning style past `STALE_WARN_MS`, the radar name when on backup, "No radar frames yet" for empty, and both attributions.
  - **Legend:** collapsed by default and opens on tap.
  - **Live follow:** if `t` is within 30 s of the newest frame when new frames arrive, `t` follows the new newest frame.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then run `npm run dev` with Playwright desktop and mobile. Expected:
  - Playback runs at 2 h per 12 s at 1×, holds at the end, then loops.
  - −2× plays backwards.
  - Keys work.
  - Nothing overlaps on a 375×667 viewport.
- [ ] **Step 5:** Commit (`feat: speed lever, clock, keyboard, status`).

---

### Task 14: Polish, performance check, production deploy

**Files:**
- Modify: whatever the checks below turn up

- [ ] **Step 1:** Run `npm test` and `npx tsc --noEmit`. Expected: PASS with 0 errors.
- [ ] **Step 2:** Run `npm run deploy`, then open the workers.dev URL on the user's phone and on desktop. Check:
  - First radar picture in < 2 s on 4G (Chrome DevTools "Fast 4G" throttling on desktop).
  - The performance panel shows ~60 fps while scrubbing, with no long tasks > 50 ms on the main thread during playback.
- [ ] **Step 3:** Run through Review Focus items 1–5 by hand against production, where feasible (e.g. API path injection via curl).
- [ ] **Step 4:** Commit (`chore: production polish`) and tell the user the URL.

---

### Task 16: Squeeze ingest CPU under the free plan's 10 ms (runs straight after Task 5)

The user chose the free plan (2026-10-27). Task 5 measured 15 ms on idle runs and 19–52 ms with downloads.

**Files:**
- Modify: `worker/ingest.ts`, `worker/index.ts`, `worker/ftpProtocol.ts` (only if needed)
- Test: `worker/ingest.test.ts`, `worker/api.test.ts` (index helpers)

**Interfaces:**
- Consumes: everything from Tasks 2–5
- Produces:
  - `runIngest(deps:{ftp; bucket; nowMs; products; radarGlob?:string; maxDownloads?:number /* now per product, default 2 */; refreshMeta?:boolean})`
  - R2 key `state/{radar}.json` = `{newest: Record<ProductId, string /* stamp */>}`
  - `radarGlob(radar:"marburg"|"stapylton"): string` (e.g. `/anon/gen/radar/IDR50?.T.*.png`)
  - `shouldRefreshMeta(scheduledTimeMs:number): boolean` (true when the UTC minute-of-hour is < 2, so each radar checks once an hour)

- [ ] **Step 1: Check the combined glob against the real server** with a throwaway Node script in the scratchpad, reusing `ReplyReader` like the Task 2 live check. Test whether `NLST /anon/gen/radar/IDR50?.T.*.png` returns all four Marburg products' names. If `?` isn't supported, try `IDR50[1-4].T.*.png`. If neither works, keep per-product globs and skip the `radarGlob` change.
- [ ] **Step 2: Write failing tests.**
  - **Idle run:** with `state/marburg.json` already holding the newest stamps and a listing that has nothing newer, the run makes exactly 1 R2 `get` (the state) and **0** `put`s. It makes no manifest `get`, and 0 FTP `retrieve`s.
  - **One new frame:** for IDR503 → 1 retrieve, 1 frame put, the IDR503 manifest read and written, the state written, and no manifest I/O for the other three products.
  - **Missing state:** behaves like today (reads the manifests) and writes the state.
  - **Per-product cap:** the default is 2.
  - **Meta:** with `refreshMeta: false` there's no meta `get`; with `true`, today's 7-day rule applies.
  - **Errors:** an FTP or R2 failure for one product still writes that product's manifest `lastError`, and leaves its state entry untouched, so the next run retries.
  - **Index helpers:** `radarGlob` returns the verified pattern, and `shouldRefreshMeta` is true at minutes 0 and 1 of the hour and false at 2–59.
- [ ] **Step 3:** Run the tests. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - **Listing:** one combined-glob NLST per run when Step 1 verified it, then `parseListing` splits it by product.
  - **State:** read `state/{radar}.json` once per run. For each product whose newest listed stamp is newer than its state (or which has no state), do today's manifest read, download and write. Write the state last, and only if it changed.
  - **`lastFetchOk`:** only updated when a manifest is written. Staleness in the app comes from the newest frame time (`chooseRadar` already uses `newestMs`).
- [ ] **Step 5:** Run `npm test` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Deploy and measure.** Run `npm run deploy`. Capture ≥ 10 cron runs with `npx wrangler tail rain-radar --format json` and record `cpuTime`, separating idle runs from runs with downloads. Target: idle ≤ 6 ms, and steady-state runs with downloads ≤ 10 ms. If it's still over, report the numbers and the biggest remaining cost. **Don't** switch plans.
- [ ] **Step 7:** Check `/api/manifest/IDR503` and `/api/day/IDR503/<today>`. Expected: frames still accumulating, and `lastError: null`.

---

### Task 17: Drop per-product manifests from ingest (CPU squeeze, part 2; runs after Task 16)

Task 16 measured download runs at a median of 19 ms. The biggest remaining per-download cost is reading, stringifying and writing that product's manifest.

**Files:**
- Modify: `worker/ingest.ts`, `worker/api.ts`, `worker/index.ts`, `worker/ftpProtocol.test.ts`
- Test: `worker/ingest.test.ts`, `worker/api.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5 and 16
- Produces:
  - `runIngest(deps:{ftp; bucket; nowMs; radar:"marburg"|"stapylton"; maxDownloads?; refreshMeta?})`. The radar is passed explicitly, and products come from `RADARS[radar].products`.
  - R2 `state/{radar}.json` = `{newest: Partial<Record<ProductId,string>>; lastOk: Partial<Record<ProductId,string /* ISO */>>; lastError: Partial<Record<ProductId,string|null>>}`. Read once per run, written once at the end, and only if it changed.
  - **No `manifest/*` writes.** Leave existing `manifest/*` objects in place; they're simply no longer read.
  - `GET /api/manifest/:product` is now built on request. It does an R2 `list` on `frames/{product}/{today UTC}` and `frames/{product}/{yesterday UTC}`, following cursors. It keeps stamps ≥ `nowMs − MANIFEST_SPAN_MS`, ascending, and fills `lastFetchOk`/`lastError` from `state/{radar of product}.json`. Same `Manifest` shape, same `max-age=30`.

- [ ] **Step 1: Write failing tests.**
  - **Ingest:**
    - A run with 1 new frame makes exactly 1 `retrieve`, 1 frame `put` and 1 state `put`, with no `manifest/` key read or written.
    - An idle run makes 1 state `get` and 0 `put`s.
    - Partial failure: the first of two downloads succeeds and the second throws. The successful frame is stored, `state.newest` for that product does **not** advance past the last contiguous stored stamp, and `lastError` is set.
    - A frame `put` that fails leaves state behind.
    - A state `put` failure goes into `report.errors` and doesn't throw.
  - **API:**
    - The manifest built from a fake bucket with frames on two UTC days returns only the last 24 h, ascending, plus `lastError` from state.
    - Unknown product → 404 with no bucket call.
    - Missing state → `lastFetchOk: null`, `lastError: null`.
  - **ReplyReader (deferred from the Task 16 review):** a multi-line reply split at `\r` and `\n` across chunks, and two replies delivered in one chunk.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** For state advancement, `newest[product]` = the newest stamp such that every listed in-window stamp up to it is stored. Simplest version: advance `newest[product]` to the newest listed in-window stamp only when every missing stamp was downloaded and stored in this run. On any failure, or when the per-product cap left a backlog, leave it unchanged. Document the rule.
- [ ] **Step 4:** Run `npm test` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Deploy and measure** (`npm run deploy`, then tail ≥ 10 runs). Target: idle ≤ 8 ms, and steady-state download runs ≤ 10 ms. Report the table. Don't switch plans.
- [ ] **Step 6:** Curl `/api/manifest/IDR503`. Expected: frames continue past the moment of deploy.

---

### Task 18: Nowcast + playback stop rules (DONE 2026-10-28)

Brief: `.superpowers/sdd/2026-10-27-rain-radar/task-18-brief.md`. Spec §6.2, §6.4, §7.7. In short:
- `forecastFlow` (mean of the last ≤ 3 flows in px/ms, filled over the whole frame), a forecast mode in the shader and its CPU mirror, and the playhead allowed up to newest + 60 min.
- No looping. Playback stops at the ends, and auto-stops on crossing "now" unless the user is dragging the tape or holding the lever.
- Violet-tinted forecast section on the tape, "+N min forecast" on the clock, and the rain hint line.
- Borders on the tape and lever (`--control-border` / `--control-shadow` in `index.html`).

### Task 19: Smoother map upsampling (DONE 2026-10-28)

Spec §7.3. Display-only cubic B-spline level lookup in `src/render/shaders.ts` (`u_smooth`; `?smooth=0|cr` switches in `radarLayer.ts`). The CPU mirror and the parity check stay bilinear. Banded colours are deliberately not done.

---

### Task 20: CPU pass 2 — every cron run ≤ 10 ms (SUPERSEDED by Task 21: the user moved to Workers Paid, so only its Step 1/2 findings and the cheaper `sampleHomeFromPng` survive)

User decisions (2026-10-28):
- **Only fetch the 128 km and 64 km ranges.** `IDR501/502/661/662` are dropped.
- **At most one frame per run is fine.**
- **Newest first, backfill on spare runs**, giving up on frames older than a few hours.
- **Measure the home sample before deciding** how to handle it.
- **If a run still can't fit, stop and ask** (Workers Paid is the fallback).

Measured before this task (after Tasks 16/17/15):
- Idle runs: 6–8 ms.
- +1 frame: ~9 ms.
- +3–4 frames: 12–23 ms (~3 ms per download).
- The home-sample cost on `IDR504` frames is unmeasured.

**Budget maths.**
- With 4 products, BOM publishes 4 frames per 5 min.
- With **one cron trigger per radar** (below), each radar gets 5 runs per 5 min for its 2 new frames, which leaves 3 spare runs per 5 min for backfill and meta.

**Files:**
- Modify:
  - `shared/config.ts` (PRODUCTS, RADARS)
  - `worker/ingest.ts`, `worker/index.ts`
  - `wrangler.jsonc` (crons)
  - `worker/api.ts` (only if the state shape changes)
  - `src/geo/*` (pickRange), `src/radar/RadarScreen.tsx` (map minZoom)
  - Tests and fixtures that name the dropped products
- Test: `worker/ingest.test.ts`, `worker/api.test.ts`, and the affected `src/` tests (lean: update, don't add many)

- [ ] **Step 1: Drop the 512/256 km products.**
  - In `shared/config.ts`, `PRODUCTS` = `IDR503, IDR504, IDR663, IDR664`, and `RADARS[*].products` likewise. Keep the tape products (`IDR504`, `IDR663`).
  - The API then 404s the dropped products. Their R2 objects stay (never deleted).
  - `pickRange` now picks between 128 and 64 km only.
  - Set the map's `minZoom` so that, on a 375 px-wide phone, the 128 km frame (~256 km across) still spans at least the screen width.
  - Fix the tests and fixtures that reference the dropped products (e.g. `pickRange` wide-view cases). `npm test` must pass.

- [ ] **Step 2: Measure the components before redesigning.**
  - Add a **temporary** route, e.g. `GET /__bench?step=N` (remove it before finishing; it must never ship). It runs one cumulative stage per request:
    1. state get + parse only
    2. + FTP connect/login/QUIT
    3. + one NLST of the radar glob
    4. + one RETR of the newest IDR503 frame
    5. + R2 put of it under a `bench/` key (delete the key afterwards)
    6. + `sampleHomeFromPng` on an IDR504 frame
  - Hit each stage ~10 times. Read `cpuTime` from `npx wrangler tail rain-radar --format json`.
  - Inside a Worker, `Date.now()` doesn't advance during CPU work, so in-code timers are useless. `cpuTime` from tail is the measurement.
  - Also check the Worker bundle for heavy imports, since startup counts on a cold isolate. For example, does the Worker pull in `fast-png` through `shared/homeSample.ts` → `decodeFrame`? If so, split the imports so the Worker only bundles the DecompressionStream path.
  - Record a table of stage → median and max cpuTime in the progress ledger. This table decides the design below.

- [ ] **Step 3: One cron trigger per radar** (replaces even/odd minute alternation).
  - In `wrangler.jsonc`, use `crons: ["* * * * *", "*/1 * * * *"]`. Both fire every minute. `event.cron` picks the radar: Marburg for the first string, Stapylton for the second.
  - Each radar keeps its own `state/{radar}.json`, so the two concurrent invocations never share state.
  - **Verify first** that Cloudflare accepts two such crons and fires both: check the docs or deploy and watch the tail. If not, fall back to Marburg on `* * * * *` and Stapylton on `*/2 * * * *`: Stapylton gets 2.5 runs per 5 min for 2 frames, which is tight but workable. If the user then wants more, a Durable Object alarm (free plan; check its CPU and duration limits first) can give any cadence, including 30 s.

- [ ] **Step 4: One frame per run, no FTP on idle runs.** Rework `runIngest` per radar.
  - **State.** `state/{radar}.json` adds, per product:
    - `missing: string[]`: known gaps, newest first, pruned past `BACKFILL_MAX_AGE_MS = 6 h`
    - `lastListMs`
    - for the tape product, a cached `geometry`, so tape runs skip the meta `get`
  - Keep `newest`, `lastOk` and `lastError`, which `/api/manifest` uses.
  - **What's due.** BOM stamps for these products are every 5 min at a fixed minute phase. For a product, `expected = newest + 5 min` is "due" once `now ≥ expected + PUBLISH_LAG_MS`.
    - Measure the real lag from a few listings; start at about 2 min.
  - **Per run, pick at most one action**, in this order:
    1. The due product with the oldest `expected`, tape product first on ties: RETR that exact name, with no listing.
       - On success: put (with the home metadata if it's the tape product), then advance `newest`.
       - On 550: leave it, and the next run retries.
    2. Else, if a product is overdue by more than ~12 min, or its `lastListMs` is older than 30 min: one NLST to resync. Set `newest` to the newest listed stamp, and add unstored stamps within 6 h to `missing`. One R2 list, as today, filters out already-stored stamps.
    3. Else, if `missing` is non-empty: RETR + put its newest entry.
    4. Else, if meta is due (7-day rule): refresh one product's `.map`.
    5. Else: **idle. Don't open FTP at all.** Just read the state and return. Opening FTP lazily, only for actions 1–4, is the biggest expected saving.
  - **Write the state only if it changed** (as now).
  - **Home sample.** If Step 2 shows that the sample pushes a tape-frame run over 10 ms, split it.
    - Put the frame without metadata, and add its stamp to `pendingHome` in the state.
    - A later spare run then does R2 get → sample → put the same bytes with `customMetadata`. That's one extra put per tape frame, about 576 a day, well inside R2's free tier.
    - Otherwise keep it inline.
  - **Log one line per run** saying what it did (`IDR504 202610281205 +home`, `list IDR503`, `backfill IDR663 …`, `idle`). This lets the tail table be grouped by action.

- [ ] **Step 5: Tests (lean).**
  - Idle run → 1 state get, 0 FTP opens, 0 puts.
  - Due product → exactly 1 RETR by name, 1 frame put, state advanced.
  - 550 → no advance, no throw.
  - Overdue → NLST resync fills `missing`.
  - Spare run → backfills the newest `missing` entry; entries older than 6 h are pruned.
  - Never more than 1 RETR of a frame per run.
  - `npm test` and `npx tsc --noEmit` clean.

- [ ] **Step 6: Deploy and measure.**
  - Remove `/__bench`, then run `npm run deploy`.
  - Tail ≥ 30 runs per radar. Report a table of action → median and max cpuTime.
  - **Target: every run ≤ 10 ms.**
  - If any action type still exceeds it after the fixes above, **stop and ask the user** with the numbers (Workers Paid is the fallback). Don't switch plans yourself.
  - Check that `/api/manifest/IDR503` and `/api/series/IDR504/<today>` keep accumulating, and that the app still loads.

---

### Task 15: "Rain at home" series recorded at ingest (runs after Task 11, before Task 12)

This feeds the zoomed-out tape (spec §6.2). Execution order: … 11 → **15** → 12 → 13 → 14.

**Files:**
- Create: `shared/homeSample.ts`
- Modify: `worker/ingest.ts`, `worker/api.ts`
- Test: `shared/homeSample.test.ts`, plus new cases in `worker/ingest.test.ts` and `worker/api.test.ts`

**Interfaces:**
- Consumes: `decodeFrame`, `LevelField` (Task 6), `lonLatToUV` (Task 9), `RadarGeometry`, `HOME`, `RADARS[*].tapeProduct`, `BucketLike` (Task 4), `ApiBucket`/`handleApi` (Task 5)
- Produces:
  - `HOME_RADIUS_M = 1000`
  - `homePixel(g:RadarGeometry): {x:number; y:number; rPx:number}`, where `x = u·512` and `y = v·512` from `lonLatToUV(g, HOME.lon, HOME.lat)`, and `rPx = HOME_RADIUS_M / metresPerPixel`. `metresPerPixel` = great-circle distance from `corners.bl` to `corners.br`, divided by 512.
  - `maxLevelInDisc(f:LevelField, x:number, y:number, rPx:number): number` (max level over pixels whose centre is within `rPx`)
  - `type SeriesDay = {product: ProductId; day: string; points: [stamp: string, level: number][] /* ascending, unique stamps */}`
  - **No series files (controller ruling R20, which replaces `appendSeriesPoint`).** For tape products, the frame `put` itself carries `customMetadata: {home: String(level)}`. There are no extra writes.
  - HTTP `GET /api/series/:product/:day` → `SeriesDay`, built from `bucket.list({prefix: "frames/{product}/{day}", include: ["customMetadata"]})` (following cursors). Frames without `home` metadata are omitted. Caching and validation reuse `dayCacheControl`.

- [ ] **Step 1: Write failing tests.**
  - `homePixel(IDR504 geom)`: x and y within (204.8, 307.2); `rPx` ≈ 4 ± 0.3 (64 km range, so 128 km across 512 px = 250 m/px).
  - `maxLevelInDisc`: a field whose only rain is a level-9 pixel 3 px right of (x, y) → 9 with `rPx` 4; the same pixel 6 px right → 0.
  - Ingest:
    - storing a frame for `IDR504` whose PNG (encoded in-test with `fast-png`) has a level-10 disc on the home pixel → the frame's `put` carries `customMetadata.home === "10"`
    - storing `IDR503` → no `home` metadata
    - garbage PNG bytes for `IDR504` → the frame is still stored and the manifest updated, and `report.errors` has 1 entry
    - meta missing and not fetchable → frame stored, series skipped, no throw
  - API: as for the day route — immutable for past days, 60 s for today, 404 for a future day or a bad day string with **no** bucket call, and 404 when the file is missing.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. In `runIngest`, geometry must be available before frames: use stored meta, refreshed hourly. Compute each tape-product frame's home level **before** its `put` and attach it as `customMetadata`. If sampling fails, put the frame without metadata and record the error. `homePixel` uses the pixel-centre convention `x = u·512 − 0.5` (matching the shader). The disc max must sample at native cell centres using `CELL_SIZE[product]`, so a lone 2×2 cell reads its full value. **CPU (free plan):** in the Worker, don't run a full `fast-png` decode. Inflate the IDAT stream with the native `DecompressionStream("deflate")` and un-filter only the rows needed to reach `y + rPx`, then classify just the disc's pixels. Keep `maxLevelInDisc` working on a `LevelField` for the browser, and add `sampleHomeFromPng(png, geom)` for the Worker, both sharing one disc routine. Test that `sampleHomeFromPng` equals `maxLevelInDisc(decodeFrame(png))` on both real fixtures (4-bit and 8-bit). Catch series errors into `report.errors`; they never block frames or the manifest.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. Then run `npm run deploy` and `npx wrangler tail rain-radar --format json` over ≥ 6 cron runs, and record `cpuTime`. If any steady-state run exceeds 10 ms, lower `maxDownloads` to 3 and recheck. If it's still over, **stop and ask the user** (Workers Paid decision). Then `curl /api/series/IDR504/<today>`. Expected: points accumulating.

### Task 21: Workers Paid, all eight products, one simple ingest (supersedes Task 20)

User, 2026-10-28: upgraded to Workers Paid; "forget all the minimising stuff and just have one worker that runs every minute and does all the things it needs to. Add back in the other radar sizes."

- Restored `IDR501/502/661/662` (config, pickRange, map minZoom, `FrameStore.startProduct`, `radarGlob` `[1-4]`, tests and fixtures all back to their pre-Task-20 state).
- One cron `* * * * *`. `scheduled` runs Marburg and Mt Stapylton in parallel (`Promise.all`), each on its own FTP connection, with one combined NLST per radar. Every missing in-window frame is downloaded (no caps), and the tape products' home level is sampled inline and stored as `customMetadata` in the same put. A failing radar does not stop the other. One log line per run.
- Removed Task 20's due/resync/pendingHome/missing scheduling and the `*/1` second trigger. Kept: per-radar `state/{radar}.json` (`newest`, `lastOk`, `lastError`), hourly meta refresh, and the cheaper `sampleHomeFromPng`.
