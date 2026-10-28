import { useState } from "react";
import { BOM_LEGEND } from "../../shared/legend";
import { MAX_LEVEL, rampColour } from "../render/colourRamp";

/** The map's colour ramp as a CSS gradient over levels 0..15, sampled every half level. */
const GRADIENT = `linear-gradient(90deg, ${Array.from({ length: 2 * MAX_LEVEL + 1 }, (_, i) => {
  const [r, g, b, a] = rampColour(i / 2);
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)}) ${((i / 2 / MAX_LEVEL) * 100).toFixed(1)}%`;
}).join(", ")})`;

/** Levels labelled with their rain rate. */
const TICKS = [1, 4, 8, 12, 15].map((level) => ({ level, mmh: BOM_LEGEND[level - 1]!.mmh }));

/**
 * The colour legend (spec §7.2), collapsed to a swatch by default; a tap opens it and another closes it.
 * The open panel is absolutely positioned against the nearest positioned ancestor (the controls panel),
 * so it opens above the tape rather than over it.
 */
export function Legend() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="colour legend"
        aria-expanded={open}
        data-testid="legend-toggle"
        onClick={() => setOpen((o) => !o)}
        onMouseDown={(e) => e.preventDefault()}
        style={{
          display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 12, cursor: "pointer",
          border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.45)", color: "#c9d4df",
          font: "600 10px system-ui, sans-serif",
        }}
      >
        <span style={{ width: 36, height: 8, borderRadius: 4, background: GRADIENT }} />
        mm/h
      </button>
      {open && (
        <div
          data-testid="legend"
          onClick={() => setOpen(false)}
          style={{
            position: "absolute", left: 0, bottom: "calc(100% + 6px)", width: 240, maxWidth: "100%", boxSizing: "border-box",
            padding: "8px 12px 6px", borderRadius: 8, background: "rgba(5,8,12,0.85)", color: "#e6edf3",
            font: "10px system-ui, sans-serif",
          }}
        >
          <div style={{ height: 10, borderRadius: 5, background: GRADIENT }} />
          <div style={{ position: "relative", height: 14, margin: "2px 0" }}>
            {TICKS.map(({ level, mmh }) => (
              <span
                key={level}
                style={{ position: "absolute", left: `${(level / MAX_LEVEL) * 100}%`, transform: "translateX(-50%)" }}
              >
                {mmh}
              </span>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", opacity: 0.7 }}>
            <span>light</span><span>heavy</span><span>severe · mm/h</span>
          </div>
        </div>
      )}
    </>
  );
}
