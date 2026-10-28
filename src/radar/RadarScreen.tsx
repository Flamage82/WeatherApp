import { useCallback, useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre finds its worker relative to its own module URL, which Vite's dep pre-bundling moves;
// point it at the (self-contained) worker file explicitly. Works in dev and in the build.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { HOME, NOWCAST_MAX_MS, RADARS } from "../../shared/config";
import { decodeFrame } from "../../shared/decodeFrame";
import { Clock } from "../controls/Clock";
import { Legend } from "../controls/Legend";
import { stepDetent } from "../controls/leverMath";
import { PlayButton } from "../controls/PlayButton";
import { rainHint } from "../controls/rainHint";
import { SpeedLever } from "../controls/SpeedLever";
import { StatusBar } from "../controls/StatusBar";
import { useKeyboard } from "../controls/useKeyboard";
import { fetchDay, fetchEarliest, fetchFrame, fetchManifest, fetchMeta } from "../data/api";
import type { RadarName } from "../data/chooseRadar";
import { createFlowClient } from "../data/flowClient";
import { FrameStore } from "../data/frameStore";
import type { RadarLayer } from "../render/radarLayer";
import { Tape } from "../tape/Tape";
import { buildHomeForecast } from "../tape/homeSeries";
import { DEFAULT_SPAN_MS, SERIES_STEP_MS } from "../tape/tapeMath";
import { stepPlayback, type PlayState } from "../time/timeline";
import { RadarView } from "./radarView";

maplibregl.setWorkerUrl(maplibreWorkerUrl);

const STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
const STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";
/** The clock's "−N min" and the status bar's "updated N min ago" are refreshed this often. */
const NOW_TICK_MS = 10_000;

/** The tape's left edge this close to the start of what's loaded → load further back (spec §6.4). */
const EXTEND_MARGIN_MS = 20 * 60_000;
const EXTEND_STEP_MS = 60 * 60_000;
/** `ensureAround` is throttled to this while the playhead moves. */
const ENSURE_THROTTLE_MS = 500;
/** A playhead this close to the newest frame (either side) is live: it follows new frames (spec §6.4). */
const LIVE_MS = 30_000;

// Spec §7.1: dark by default; light only when the system explicitly asks for it.
const lightQuery = () => window.matchMedia("(prefers-color-scheme: light)");
const styleFor = (light: boolean) => (light ? STYLE_LIGHT : STYLE_DARK);

/**
 * Put the radar above every road/boundary/fill layer but under the trailing run of label (symbol)
 * layers, so place names stay readable. (Some styles have early symbol layers, e.g. water names,
 * so "before the first symbol" would leave roads drawn over the rain.)
 */
function addRadarLayer(map: maplibregl.Map, layer: RadarLayer) {
  try {
    if (map.getLayer(layer.id)) return;
    const layers = map.getStyle()?.layers;
    if (!layers) return; // style not loaded; "style.load" adds it
    let i = layers.length;
    while (i > 0 && layers[i - 1]!.type === "symbol") i--;
    map.addLayer(layer, layers[i]?.id);
  } catch (e) {
    // Style not loaded yet (first load or mid setStyle): the "style.load" handler adds it.
    if (!(e instanceof Error && /not done loading/i.test(e.message))) throw e;
  }
}

type Ui = {
  t: number;
  live: boolean;
  radar: RadarName | null;
  status: FrameStore["status"];
  newestMs: number | null;
  /** The "rain at home" line from the nowcast (`rainHint`). */
  hint: string | null;
};

export function RadarScreen() {
  const containerRef = useRef<HTMLDivElement>(null);
  const storeRef = useRef<FrameStore | null>(null);
  const viewRef = useRef<RadarView | null>(null);
  const [store, setStore] = useState<FrameStore | null>(null);
  const [ui, setUi] = useState<Ui | null>(null);
  const [spanMs, setSpanMs] = useState(DEFAULT_SPAN_MS);
  const spanRef = useRef(spanMs);
  spanRef.current = spanMs;
  // Playback: `play.t` is the playhead while playing. It runs from the loaded start to the nowcast's end,
  // stopping at either end and where it crosses the newest frame, unless the user is driving the tape
  // or holding the lever (`manual`).
  const play = useRef<PlayState>({ t: 0, speed: 0, lastSpeed: 1 });
  const manual = useRef({ tape: false, lever: false });
  const [speed, setSpeedUi] = useState(0);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const container = containerRef.current!;
    const mq = lightQuery();
    const map = new maplibregl.Map({
      container,
      style: styleFor(mq.matches),
      center: [HOME.lon, HOME.lat],
      zoom: 9,
      // The status bar carries both attributions (MapLibre's control opens expanded over the tape on phones).
      attributionControl: false,
      // Arrow keys step time (useKeyboard), so the map doesn't pan with them.
      keyboard: false,
    });
    new maplibregl.Marker({ color: "#e11d48" }).setLngLat([HOME.lon, HOME.lat]).addTo(map);

    const flow = createFlowClient();
    const store = new FrameStore({
      api: { fetchManifest, fetchFrame, fetchMeta, fetchDay, fetchEarliest },
      decode: decodeFrame,
      flow: flow.compute,
      now: Date.now,
    });
    const view = new RadarView(map, store, (l) => addRadarLayer(map, l), () => publish());
    storeRef.current = store;
    viewRef.current = view;
    setStore(store);

    function publish() {
      // The nowcast at home from the newest frame, whatever the playhead. A nowcast not ready yet (a new
      // frame whose flow is still computing) keeps the last line.
      const p = store.radar ? RADARS[store.radar].tapeProduct : null;
      const geom = p ? store.geometry(p) : null;
      const fc = p && geom ? buildHomeForecast(store, p, geom) : null;
      setUi((u) => ({
        t: view.time(), live: view.isLive(), radar: store.radar, status: store.status, newestMs: store.newestMs,
        hint: fc ? rainHint(fc.values, SERIES_STEP_MS) : (u?.hint ?? null),
      }));
    }
    // While playing, a playhead at the newest frame follows new frames (paused, a live view follows by
    // itself). One inside the nowcast keeps its time, clamped to the nowcast's end.
    let newest = store.loadedWindow().end;
    const onChange = () => {
      const end = store.loadedWindow().end;
      const p = play.current;
      if (end > newest && p.speed !== 0 && Math.abs(p.t - newest) <= LIVE_MS) play.current = { ...p, t: end };
      if (play.current.t > end + NOWCAST_MAX_MS) play.current = { ...play.current, t: end + NOWCAST_MAX_MS };
      if (!view.isLive() && view.time() > end + NOWCAST_MAX_MS) view.setTime(end + NOWCAST_MAX_MS);
      newest = end;
      view.onStoreChange();
      publish();
    };
    store.addEventListener("change", onChange);

    // Custom layers don't survive setStyle, so (re-)add the radar on every style load.
    map.on("style.load", () => {
      if (view.layer) addRadarLayer(map, view.layer);
      view.onStoreChange();
    });
    // Range choice (spec §7.5): only a zoom that changes the best range does anything.
    map.on("moveend", () => {
      view.onMoveEnd();
      publish();
    });
    const onScheme = (e: MediaQueryListEvent) => map.setStyle(styleFor(e.matches), { diff: false });
    mq.addEventListener("change", onScheme);

    store.start().catch((e: unknown) => console.error("frame store start failed", e));

    // DEV-only handle for Playwright checks.
    if (import.meta.env.DEV) Object.assign(window, { __radar: { map, store, view } });

    return () => {
      store.removeEventListener("change", onChange);
      store.stop();
      flow.terminate();
      mq.removeEventListener("change", onScheme);
      view.dispose();
      map.remove();
      storeRef.current = viewRef.current = null;
      setStore(null);
    };
  }, []);

  // Moving the playhead (scrubbing, keys, playback) moves the view and the decode window.
  const lastEnsure = useRef(0);
  const applyTime = useCallback((v: number) => {
    const store = storeRef.current, view = viewRef.current;
    if (!store || !view) return;
    const w = store.loadedWindow();
    const live = Math.abs(v - w.end) <= LIVE_MS;
    view.setTime(live ? null : v);
    if (live) {
      // Live: the decode window must follow new frames, so unpin the focus (never throttled).
      store.ensureAround(null);
    } else {
      const now = performance.now();
      if (now - lastEnsure.current >= ENSURE_THROTTLE_MS) {
        lastEnsure.current = now;
        store.ensureAround(v);
      }
    }
    // Keep stamps known back past the tape's visible left edge, so it can keep scrolling (no 24 h limit).
    const edge = v - spanRef.current / 2;
    if (edge - w.start < EXTEND_MARGIN_MS) store.extendBack(Math.min(w.start, edge) - EXTEND_STEP_MS);
    setUi((u) => (u ? { ...u, t: view.time(), live } : u));
  }, []);

  // A user move (tape or keys; already clamped to the loaded start .. the nowcast's end). While playing,
  // playback carries on from there.
  const onScrub = (v: number) => {
    applyTime(v);
    if (play.current.speed !== 0) play.current = { ...play.current, t: v };
  };

  const setSpeed = (s: number) => {
    const view = viewRef.current, store = storeRef.current;
    if (!view || !store) return;
    const p = play.current;
    if (p.speed === 0 && s !== 0) {
      // Play pressed: start from the playhead; at live, exactly at the newest frame, so that playing
      // forward runs on into the nowcast instead of stopping at once.
      const end = store.loadedWindow().end, t = view.time();
      play.current = { ...p, t: Math.abs(t - end) <= LIVE_MS ? end : t };
    }
    play.current = { ...play.current, speed: s, lastSpeed: s !== 0 ? s : p.lastSpeed };
    setSpeedUi(s);
  };
  const togglePlay = () => setSpeed(play.current.speed === 0 ? play.current.lastSpeed : 0);

  const playing = speed !== 0;
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = Math.max(0, now - last);
      last = now;
      const store = storeRef.current;
      if (!store) return;
      const w = store.loadedWindow(), m = manual.current;
      play.current = stepPlayback(play.current, dt, { start: w.start, end: w.end + NOWCAST_MAX_MS, now: w.end }, m.tape || m.lever);
      applyTime(play.current.t);
      if (play.current.speed === 0) setSpeedUi(0); // stopped at an end, or at now
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, applyTime]);

  useKeyboard({
    togglePlay,
    step: (d) => {
      const store = storeRef.current, view = viewRef.current;
      if (!store || !view) return;
      const { start, end } = store.loadedWindow();
      onScrub(Math.min(Math.max(view.time() + d, start), end + NOWCAST_MAX_MS));
    },
    stepSpeed: (dir) => setSpeed(stepDetent(play.current.speed, dir)),
  });
  // Trailing ensureAround once the playhead rests, so the final position is loaded
  // (null when it rests at live, so the window keeps following the newest frame).
  useEffect(() => {
    if (!ui) return;
    const id = setTimeout(() => storeRef.current?.ensureAround(ui.live ? null : ui.t), ENSURE_THROTTLE_MS);
    return () => clearTimeout(id);
  }, [ui?.t, ui?.live]);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {store && ui && <Clock t={ui.t} now={now} newestMs={store.loadedWindow().end} hint={ui.hint} />}
      {/* The lever, centred in the space between the clock and the controls (at most 240 px tall). */}
      <div
        style={{
          position: "absolute", right: 12, top: "calc(76px + env(safe-area-inset-top))",
          bottom: "calc(200px + env(safe-area-inset-bottom))", maxHeight: 240, margin: "auto 0",
        }}
      >
        <SpeedLever speed={speed} onChange={setSpeed} onHold={(h) => { manual.current.lever = h; }} />
      </div>
      {store && ui && (
        <div
          style={{
            position: "absolute", left: 0, right: 0, bottom: 0,
            padding: "24px 8px calc(6px + env(safe-area-inset-bottom))",
            background: "linear-gradient(transparent, rgba(5,8,12,0.85) 24px)",
          }}
        >
          {/* Positioned, so the open legend sits above the tape. */}
          <div style={{ position: "relative", maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 6 }}>
            <div
              style={{
                borderRadius: 8, overflow: "hidden", background: "rgba(0,0,0,0.6)",
                border: "1px solid var(--control-border)", boxShadow: "var(--control-shadow)",
              }}
            >
              <Tape
                store={store} t={ui.t} spanMs={spanMs} onScrub={onScrub} onSpanChange={setSpanMs}
                onGesture={(a) => { manual.current.tape = a; }}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center" }}>
              <div style={{ justifySelf: "start" }}><Legend /></div>
              <PlayButton playing={playing} onToggle={togglePlay} />
            </div>
            <StatusBar status={ui.status} radar={ui.radar} newestMs={ui.newestMs} now={now} />
          </div>
        </div>
      )}
    </div>
  );
}
