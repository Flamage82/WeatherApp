import type { ReactNode } from "react";

type Props = { label: string; onClick(): void; children: ReactNode };

/** A round control that floats over the map (search, locate): the dark translucent fill of the other controls. */
export function MapButton({ label, onClick, children }: Props) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      // Don't take focus on click, so Space keeps meaning play/pause (useKeyboard).
      onMouseDown={(e) => e.preventDefault()}
      style={{
        width: 40, height: 40, borderRadius: "50%", padding: 0, cursor: "pointer",
        border: "1px solid var(--control-border)", boxShadow: "var(--control-shadow)",
        background: "rgba(5,8,12,0.65)", color: "#e6edf3", display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      {children}
    </button>
  );
}
