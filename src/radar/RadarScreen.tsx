import { useCallback, useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre finds its worker relative to its own module URL, which Vite's dep pre-bundling moves;
// point it at the (self-contained) worker file explicitly. Works in dev and in the build.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { NOWCAST_MAX_MS } from "../../shared/config";
import { decodeFrame } from "../../shared/decodeFrame";
import { Clock } from "../controls/Clock";
import { Legend } from "../controls/Legend";
import { stepDetent } from "../controls/leverMath";
import { MapButton } from "../controls/MapButton";
import { PlayButton } from "../controls/PlayButton";
import { RadarSwitch } from "../controls/RadarSwitch";
import { rainHint } from "../controls/rainHint";
import { SearchBox } from "../controls/SearchBox";
import { SpeedLever } from "../controls/SpeedLever";
import { StatusBar } from "../controls/StatusBar";
import { Toast } from "../controls/Toast";
import { useKeyboard } from "../controls/useKeyboard";
import { fetchDay, fetchEarliest, fetchFrame, fetchManifest, fetchMeta } from "../data/api";
import type { RadarName } from "../data/chooseRadar";
import { createFlowClient } from "../data/flowClient";
import { sweepFrameCache } from "../data/frameCache";
import { FrameStore } from "../data/frameStore";
import type { Place } from "../location/geocode";
import { locateOnce } from "../location/locate";
import { BRISBANE, inCoverage, loadLocation, rememberDefault, saveLocation, type SavedLocation } from "../location/location";
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
/** How long a message from the location controls stays up. */
const TOAST_MS = 3_000;
/** How often the on-device frame cache drops its expired entries while the page is open. */
const SWEEP_MS = 6 * 3_600_000;

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
  /** The radar in use isn't the preferred one. */
  fallback: boolean;
  newestMs: number | null;
  /** The "rain here" line from the nowcast (`rainHint`). */
  hint: string | null;
};

/** Keeps stamps known back past the tape's visible left edge, so it can keep scrolling (no 24 h limit). */
function keepStampsBack(store: FrameStore, t: number, spanMs: number) {
  const start = store.loadedWindow().start;
  const edge = t - spanMs / 2;
  if (edge - start < EXTEND_MARGIN_MS) store.extendBack(Math.min(start, edge) - EXTEND_STEP_MS);
}

/** The saved location, or null when there is none (or the browser won't let us look). */
function readSavedLocation(): SavedLocation | null {
  try {
    return loadLocation(localStorage);
  } catch {
    return null;
  }
}

export function RadarScreen() {
  const containerRef = useRef<HTMLDivElement>(null);
  const storeRef = useRef<FrameStore | null>(null);
  const viewRef = useRef<RadarView | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  // The saved location, else Brisbane (and a one-shot fix, below). Read once.
  const [initial] = useState(() => {
    const saved = readSavedLocation();
    return { location: saved ?? { ...BRISBANE, radarOverride: null }, saved: saved !== null };
  });
  const [location, setLocation] = useState<SavedLocation>(initial.location);
  const [searching, setSearching] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
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
      center: [initial.location.lon, initial.location.lat],
      zoom: 9,
      // The status bar carries both attributions (MapLibre's control opens expanded over the tape on phones).
      attributionControl: false,
      // Arrow keys step time (useKeyboard), so the map doesn't pan with them.
      keyboard: false,
    });
    const marker = new maplibregl.Marker({ color: "#e11d48" }).setLngLat([initial.location.lon, initial.location.lat]).addTo(map);
    mapRef.current = map;
    markerRef.current = marker;

    const flow = createFlowClient();
    const store = new FrameStore({
      api: { fetchManifest, fetchFrame, fetchMeta, fetchDay, fetchEarliest },
      decode: decodeFrame,
      flow: flow.compute,
      now: Date.now,
      location: { point: initial.location, override: initial.location.radarOverride },
    });
    const view = new RadarView(map, store, (l) => addRadarLayer(map, l));
    storeRef.current = store;
    viewRef.current = view;
    setStore(store);

    function publish() {
      // The nowcast at the location from the newest frame, whatever the playhead. A nowcast not ready yet
      // (a new frame whose flow is still computing) keeps the last line, unless the location or tape product
      // moved: the old line is about somewhere else.
      const fc = buildHomeForecast(store, store.tapeProducts(), store.location);
      const key = `${store.location.lat},${store.location.lon},${store.tapeProduct}`;
      const same = key === hintKey;
      hintKey = key;
      setUi((u) => ({
        t: view.time(), live: view.isLive(), radar: store.radar, status: store.status, fallback: store.fallback,
        newestMs: store.newestMs,
        hint: fc ? rainHint(fc.values, SERIES_STEP_MS) : same ? (u?.hint ?? null) : null,
      }));
    }
    let hintKey = "";
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
    // Nested ranges (nested-ranges spec §5): the view decides which ranges to load in full.
    map.on("moveend", () => {
      view.onMoveEnd();
      publish();
    });
    const onScheme = (e: MediaQueryListEvent) => map.setStyle(styleFor(e.matches), { diff: false });
    mq.addEventListener("change", onScheme);

    store.start().catch((e: unknown) => console.error("frame store start failed", e));

    // Frames cached on the phone are dropped a week after they were stored: sweep now and every 6 h.
    void sweepFrameCache(Date.now());
    const sweepId = setInterval(() => void sweepFrameCache(Date.now()), SWEEP_MS);

    // DEV-only handle for Playwright checks.
    if (import.meta.env.DEV) Object.assign(window, { __radar: { map, store, view } });

    return () => {
      clearInterval(sweepId);
      mapRef.current = markerRef.current = null;
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

  const showToast = useCallback((message: string) => {
    clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  /** Moves the pin, the tape and the hint to `next` (not outside radar coverage), and remembers it. */
  const applyLocation = useCallback((next: SavedLocation, recentre = true) => {
    const map = mapRef.current, marker = markerRef.current, store = storeRef.current;
    if (!map || !marker || !store) return;
    if (!inCoverage(next)) {
      showToast("Outside radar coverage");
      return;
    }
    try {
      saveLocation(localStorage, next);
    } catch {
      // No storage: the location just isn't remembered.
    }
    marker.setLngLat([next.lon, next.lat]);
    if (recentre) map.easeTo({ center: [next.lon, next.lat] });
    store.setLocation({ lat: next.lat, lon: next.lon }, next.radarOverride);
    setLocation(next);
  }, [showToast]);

  /** One device fix; the pin stays where it lands until this is tapped again. */
  const locate = useCallback(async () => {
    try {
      applyLocation({ ...(await locateOnce()), radarOverride: null });
    } catch {
      showToast("Couldn't get your location");
    }
  }, [applyLocation, showToast]);
  // First ever open: Brisbane is drawn at once, and the fix moves it if it arrives.
  useEffect(() => {
    // Whatever comes of the fix (denied, outside coverage, a timeout), remember the start, so later opens don't ask again.
    if (!initial.saved) void locate().finally(() => {
      try {
        rememberDefault(localStorage);
      } catch {
        // No storage: it asks again next time.
      }
    });
  }, []);

  const pickPlace = (p: Place) => {
    setSearching(false);
    applyLocation({ lat: p.lat, lon: p.lon, name: p.name, radarOverride: null });
  };

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
    keepStampsBack(store, v, spanRef.current);
    setUi((u) => (u ? { ...u, t: view.time(), live } : u));
  }, []);

  // Zooming out alone moves the tape's left edge back, so the stamps behind it are learnt here too.
  useEffect(() => {
    const store = storeRef.current, view = viewRef.current;
    if (store && view) keepStampsBack(store, view.time(), spanMs);
  }, [spanMs]);

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
      <div style={{ position: "absolute", left: 12, top: "calc(10px + env(safe-area-inset-top))" }}>
        <MapButton label="search for a place" onClick={() => setSearching(true)}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="7.5" cy="7.5" r="5" />
            <path d="M11.5 11.5L16 16" />
          </svg>
        </MapButton>
      </div>
      <div style={{ position: "absolute", right: 12, top: "calc(10px + env(safe-area-inset-top))" }}>
        <MapButton label="use my location" onClick={() => void locate()}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="9" cy="9" r="4.5" />
            <path d="M9 0.5v3M9 14.5v3M0.5 9h3M14.5 9h3" />
          </svg>
        </MapButton>
      </div>
      {searching && <SearchBox near={location} onPick={pickPlace} onClose={() => setSearching(false)} />}
      <Toast message={toast} />
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
              <div style={{ justifySelf: "end" }}>
                <RadarSwitch radar={ui.radar} onPick={(r) => applyLocation({ ...location, radarOverride: r }, false)} />
              </div>
            </div>
            <StatusBar status={ui.status} radar={ui.radar} fallback={ui.fallback} newestMs={ui.newestMs} now={now} />
          </div>
        </div>
      )}
    </div>
  );
}
