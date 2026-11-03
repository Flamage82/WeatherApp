import { useEffect, useState } from "react";
import type { LatLon } from "../../shared/types";
import { searchPlaces, type Place } from "../location/geocode";

/** Typing pauses this long before a search goes out. */
const DEBOUNCE_MS = 300;

type Props = { near: LatLon; onPick(p: Place): void; onClose(): void };

/**
 * The place search across the top of the screen (movable-location spec §4.3): suggestions as you type,
 * Enter takes the first, Escape or a tap outside closes without changing anything.
 */
export function SearchBox({ near, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  /** Null until a search for the current query has come back. */
  const [places, setPlaces] = useState<Place[] | null>(null);

  useEffect(() => {
    setPlaces(null);
    if (query.trim().length < 2) return;
    const ctl = new AbortController();
    const id = setTimeout(() => {
      searchPlaces(query, near, ctl.signal).then(setPlaces, () => {
        if (!ctl.signal.aborted) setPlaces([]);
      });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(id);
      ctl.abort();
    };
  }, [query, near.lat, near.lon]);

  return (
    <>
      {/* A tap outside the box closes it. */}
      <div onPointerDown={onClose} style={{ position: "absolute", inset: 0, zIndex: 20 }} />
      <div
        style={{
          position: "absolute", zIndex: 21, left: 12, right: 12, top: "calc(10px + env(safe-area-inset-top))",
          maxWidth: 480, margin: "0 auto", font: "14px system-ui, sans-serif",
        }}
      >
        <input
          autoFocus
          type="search"
          role="searchbox"
          aria-label="search for a place"
          placeholder="Search for a place"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "Enter" && places?.[0]) onPick(places[0]);
          }}
          style={{
            width: "100%", boxSizing: "border-box", height: 40, padding: "0 14px", borderRadius: 20, outline: "none",
            border: "1px solid var(--control-border)", boxShadow: "var(--control-shadow)",
            background: "rgba(5,8,12,0.9)", color: "#e6edf3", font: "inherit",
          }}
        />
        {places && (
          <ul
            style={{
              listStyle: "none", margin: "6px 0 0", padding: 4, borderRadius: 12, overflow: "hidden",
              border: "1px solid var(--control-border)", boxShadow: "var(--control-shadow)", background: "rgba(5,8,12,0.9)",
            }}
          >
            {places.length === 0 && <li style={{ padding: "8px 10px", color: "#9aa7b4" }}>No places found in radar coverage</li>}
            {places.map((p) => (
              <li key={`${p.lat},${p.lon},${p.name}`}>
                <button
                  type="button"
                  onClick={() => onPick(p)}
                  style={{
                    display: "block", width: "100%", padding: "8px 10px", border: "none", borderRadius: 8, cursor: "pointer",
                    background: "transparent", color: "#e6edf3", textAlign: "left", font: "inherit",
                  }}
                >
                  {p.name}
                  {p.detail && <span style={{ color: "#9aa7b4" }}>{` · ${p.detail}`}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
