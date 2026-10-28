import { useRef, type PointerEvent } from "react";
import { leverToSpeed, speedToLever } from "./leverMath";

const KNOB = 30;
const LABELS = [4, 2, 0, -2, -4];

/** "1×", "1.6×", "−2×"; "0" when paused. */
export const fmtSpeed = (s: number) =>
  s === 0 ? "0" : `${s < 0 ? "−" : ""}${Number.isInteger(s) ? Math.abs(s) : Math.abs(s).toFixed(1)}×`;

type Props = { speed: number; onChange(speed: number): void };

/**
 * The speed lever (spec §6.3): vertical, −4× at the bottom to +4× at the top, with light detents.
 * Press or drag anywhere on it (pointer-captured); it stays where it's left.
 */
export function SpeedLever({ speed, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Knob centre travels between KNOB/2 from the top and from the bottom.
  const yOf = (pos: number) => `calc(${KNOB / 2}px + (100% - ${KNOB}px) * ${1 - pos})`;

  const update = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    onChange(leverToSpeed(1 - (e.clientY - r.top - KNOB / 2) / (r.height - KNOB)));
  };

  return (
    <div
      ref={ref}
      role="slider"
      aria-label="playback speed"
      aria-orientation="vertical"
      aria-valuemin={-4}
      aria-valuemax={4}
      aria-valuenow={Math.round(speed * 10) / 10}
      data-testid="speed-lever"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        update(e);
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && update(e)}
      style={{
        position: "relative", width: 40, height: "100%", borderRadius: 20, boxSizing: "border-box",
        background: "rgba(0,0,0,0.45)", border: "1px solid rgba(255,255,255,0.15)",
        touchAction: "none", userSelect: "none", cursor: "ns-resize",
        font: "700 10px system-ui, sans-serif", color: "#c9d4df",
      }}
    >
      {LABELS.map((s) => (
        <span
          key={s}
          style={{ position: "absolute", left: 0, right: 0, top: yOf(speedToLever(s)), transform: "translateY(-50%)", textAlign: "center" }}
        >
          {fmtSpeed(s)}
        </span>
      ))}
      <span
        style={{
          position: "absolute", left: "50%", top: yOf(speedToLever(speed)), width: KNOB, height: KNOB,
          transform: "translate(-50%, -50%)", borderRadius: "50%", background: speed === 0 ? "#64748b" : "#3b82f6",
          color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9,
          boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
        }}
      >
        {fmtSpeed(speed)}
      </span>
    </div>
  );
}
