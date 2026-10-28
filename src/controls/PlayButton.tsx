type Props = { playing: boolean; onToggle(): void };

/** Play/pause (spec §6.3): switches between paused and the lever's last non-zero speed. */
export function PlayButton({ playing, onToggle }: Props) {
  return (
    <button
      type="button"
      aria-label={playing ? "pause" : "play"}
      data-testid="play"
      onClick={onToggle}
      // Don't take focus on click, so Space keeps meaning play/pause (useKeyboard).
      onMouseDown={(e) => e.preventDefault()}
      style={{
        width: 40, height: 40, borderRadius: "50%", border: "none", padding: 0, cursor: "pointer",
        background: "#e6edf3", color: "#0d1117", display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        {playing
          ? <path d="M3 2h3.5v12H3zM9.5 2H13v12H9.5z" fill="currentColor" />
          : <path d="M4 1.5v13L14 8z" fill="currentColor" />}
      </svg>
    </button>
  );
}
