import { useEffect, useRef } from "react";

const STEP_MS = 5 * 60_000;
const FINE_STEP_MS = 60_000;

type Handlers = {
  togglePlay(): void;
  /** Move the playhead by `deltaMs`. */
  step(deltaMs: number): void;
  /** One detent slower (−1) or faster (+1). */
  stepSpeed(dir: number): void;
};

/**
 * Desktop keys (spec §6.5): Space = play/pause; ← / → = ∓5 min (Shift: ∓1 min); `[` / `]` = speed one
 * detent down / up. Ignored with Ctrl/⌘/Alt held, and Space is left to a focused button.
 */
export function useKeyboard(handlers: Handlers): void {
  const h = useRef(handlers);
  h.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      switch (e.key) {
        case " ":
          if (target?.closest("button")) return;
          if (!e.repeat) h.current.togglePlay();
          break;
        case "ArrowLeft":
        case "ArrowRight":
          h.current.step((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? FINE_STEP_MS : STEP_MS));
          break;
        case "[":
        case "]":
          h.current.stepSpeed(e.key === "[" ? -1 : 1);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
