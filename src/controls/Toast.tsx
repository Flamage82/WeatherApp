/** A brief message in a small pill above the tape; nothing while `message` is null. */
export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="status"
      data-testid="toast"
      style={{
        position: "absolute", left: "50%", transform: "translateX(-50%)", bottom: "calc(170px + env(safe-area-inset-bottom))",
        padding: "6px 14px", borderRadius: 14, pointerEvents: "none", whiteSpace: "nowrap",
        background: "rgba(5,8,12,0.85)", color: "#e6edf3", border: "1px solid var(--control-border)",
        boxShadow: "var(--control-shadow)", font: "600 12px system-ui, sans-serif",
      }}
    >
      {message}
    </div>
  );
}
