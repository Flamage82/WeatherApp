import type { RadarName } from "../data/chooseRadar";

type Props = { radar: RadarName | null; onPick(r: RadarName): void };

const SEGMENTS: { radar: RadarName; label: string }[] = [
  { radar: "marburg", label: "Marburg" },
  { radar: "stapylton", label: "Stapylton" },
];

/** The two-way radar switch: the radar in use is highlighted, and tapping the other side takes it by hand. */
export function RadarSwitch({ radar, onPick }: Props) {
  return (
    <div
      role="group"
      aria-label="radar"
      style={{
        display: "flex", borderRadius: 12, overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.45)",
      }}
    >
      {SEGMENTS.map((s) => (
        <button
          key={s.radar}
          type="button"
          aria-pressed={radar === s.radar}
          data-testid={`radar-${s.radar}`}
          onClick={() => onPick(s.radar)}
          onMouseDown={(e) => e.preventDefault()}
          style={{
            padding: "4px 8px", border: "none", cursor: "pointer", font: "600 10px system-ui, sans-serif",
            background: radar === s.radar ? "#e6edf3" : "transparent", color: radar === s.radar ? "#0d1117" : "#c9d4df",
          }}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
