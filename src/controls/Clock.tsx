import { formatClock } from "./formatClock";

type Props = { t: number; now: number };

/** The displayed time, large at the top centre, with its age underneath (spec §6.1). */
export function Clock({ t, now }: Props) {
  const { time, rel } = formatClock(t, now);
  return (
    <div
      data-testid="clock"
      style={{
        position: "absolute", top: "calc(10px + env(safe-area-inset-top))", left: "50%", transform: "translateX(-50%)",
        textAlign: "center", color: "#fff", textShadow: "0 1px 4px #000", pointerEvents: "none",
        font: "700 26px/1.15 system-ui, sans-serif", whiteSpace: "nowrap",
        // A backdrop keeps it readable on the light base map too.
        padding: "4px 14px 5px", borderRadius: 12, background: "rgba(5,8,12,0.45)",
      }}
    >
      {time}
      <div style={{ font: "500 12px system-ui, sans-serif", color: "#c3cfdb" }}>{rel}</div>
    </div>
  );
}
