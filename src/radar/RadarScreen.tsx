import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre finds its worker relative to its own module URL, which Vite's dep pre-bundling moves;
// point it at the (self-contained) worker file explicitly. Works in dev and in the build.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { HOME, type ProductId } from "../../shared/config";
import { decodeFrame } from "../../shared/decodeFrame";
import { fetchDay, fetchEarliest, fetchFrame, fetchManifest, fetchMeta } from "../data/api";
import { createFlowClient } from "../data/flowClient";
import { FrameStore } from "../data/frameStore";
import type { RadarLayer } from "../render/radarLayer";
import { RadarView } from "./radarView";

maplibregl.setWorkerUrl(maplibreWorkerUrl);

const STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
const STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";
const BOM_ATTRIBUTION = "Radar data © Commonwealth of Australia, Bureau of Meteorology";

/** Playhead this close to the start of what's loaded → load further back (spec §6.4). */
const EXTEND_MARGIN_MS = 20 * 60_000;
const EXTEND_STEP_MS = 60 * 60_000;
/** `ensureAround` is throttled to this while the playhead moves. */
const ENSURE_THROTTLE_MS = 500;
/** A playhead this close to the newest frame is live: it follows new frames (Task 13 uses the same). */
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
  start: number;
  end: number;
  t: number;
  live: boolean;
  radar: string;
  status: string;
  product: ProductId | null;
};

const fmtTime = (ms: number) =>
  new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane", weekday: "short", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(ms);

export function RadarScreen() {
  const containerRef = useRef<HTMLDivElement>(null);
  const storeRef = useRef<FrameStore | null>(null);
  const viewRef = useRef<RadarView | null>(null);
  const [ui, setUi] = useState<Ui | null>(null);

  useEffect(() => {
    const container = containerRef.current!;
    const mq = lightQuery();
    const map = new maplibregl.Map({
      container,
      style: styleFor(mq.matches),
      center: [HOME.lon, HOME.lat],
      zoom: 9,
      attributionControl: { compact: true, customAttribution: BOM_ATTRIBUTION },
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

    function publish() {
      const w = store.loadedWindow();
      setUi({
        start: w.start, end: w.end, t: view.time(), live: view.isLive(),
        radar: store.radar ?? "…", status: store.status, product: view.product,
      });
    }
    const onChange = () => {
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
    };
  }, []);

  // TEMP (Task 12): the tape replaces this time control; it reuses the same store calls.
  const lastEnsure = useRef(0);
  const onScrub = (v: number) => {
    const store = storeRef.current, view = viewRef.current;
    if (!store || !view) return;
    const w = store.loadedWindow();
    const live = v >= w.end - LIVE_MS;
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
    if (v - w.start < EXTEND_MARGIN_MS) store.extendBack(w.start - EXTEND_STEP_MS);
    setUi((u) => (u ? { ...u, t: view.time(), live } : u));
  };
  // TEMP (Task 12): trailing ensureAround once the control rests, so the final position is loaded
  // (null when it rests at live, so the window keeps following the newest frame).
  useEffect(() => {
    if (!ui) return;
    const id = setTimeout(() => storeRef.current?.ensureAround(ui.live ? null : ui.t), ENSURE_THROTTLE_MS);
    return () => clearTimeout(id);
  }, [ui?.t, ui?.live]);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {/* TEMP (Task 12): scaffold time control over the loaded window, replaced by the tape and lever. */}
      {ui && (
        <label
          style={{
            position: "absolute", top: 8, left: 8, right: 8, maxWidth: 560, padding: "6px 10px", borderRadius: 6,
            background: "rgba(0,0,0,0.6)", color: "#fff", font: "12px system-ui, sans-serif",
            display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, boxSizing: "border-box",
          }}
        >
          <input
            type="range" min={ui.start} max={ui.end} step={10_000} value={ui.live ? ui.end : ui.t}
            aria-label="time (temporary)" style={{ flex: "1 1 200px", minWidth: 0 }}
            onChange={(e) => onScrub(Number(e.target.value))}
          />
          <span data-testid="radar-time" style={{ minWidth: 96 }}>
            {fmtTime(ui.t)}{ui.live ? " (live)" : ""}
          </span>
          <span data-testid="radar-status" style={{ opacity: 0.7 }}>
            {ui.radar} · {ui.status} · {ui.product ?? "…"} · from {fmtTime(ui.start)}
          </span>
        </label>
      )}
    </div>
  );
}
