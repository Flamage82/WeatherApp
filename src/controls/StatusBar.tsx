import { STALE_WARN_MS, type RadarName } from "../data/chooseRadar";

type Props = {
  status: "ok" | "stale" | "empty";
  radar: RadarName | null;
  /** The newest frame's time; staleness is judged from it alone. */
  newestMs: number | null;
  now: number;
};

const linkStyle = { color: "inherit" };

function age(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 120 ? `${min} min` : `${Math.round(min / 60)} h`;
}

/**
 * Small print under the controls (spec §6.1, §7.6): how old the newest frame is (a warning past
 * STALE_WARN_MS), the radar when on the backup, and the attributions (BOM + base map; MapLibre's own
 * attribution control is off).
 */
export function StatusBar({ status, radar, newestMs, now }: Props) {
  const stale = newestMs !== null && now - newestMs > STALE_WARN_MS;
  return (
    <div style={{ textAlign: "center", color: "rgba(230,237,243,0.7)", font: "10px/1.35 system-ui, sans-serif" }}>
      <div data-testid="radar-status" style={{ fontSize: 11, color: stale ? "#fbbf24" : undefined, fontWeight: stale ? 600 : undefined }}>
        {status === "empty" || newestMs === null ? "No radar frames yet" : `${stale ? "⚠ " : ""}updated ${age(now - newestMs)} ago`}
        {radar === "stapylton" && " · Mt Stapylton radar (backup)"}
      </div>
      <div style={{ opacity: 0.75 }}>
        Radar data © Commonwealth of Australia, Bureau of Meteorology ·{" "}
        <a href="https://openfreemap.org" target="_blank" rel="noreferrer" style={linkStyle}>OpenFreeMap</a>{" "}
        <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer" style={linkStyle}>© OpenMapTiles</a>{" "}
        Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" style={linkStyle}>OpenStreetMap</a>
      </div>
    </div>
  );
}
