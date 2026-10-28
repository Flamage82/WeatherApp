const fmtTime = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Brisbane", hour: "numeric", minute: "2-digit", hour12: true,
});

/**
 * The clock's text for time `tMs` (spec §6.1): Brisbane time ("4:35 pm") and its age relative to
 * `nowMs` ("now" within a minute, "−15 min", "−1 h 05 min"). Past the newest frame `newestMs` it is
 * the nowcast's lead instead ("+25 min forecast").
 */
export function formatClock(tMs: number, nowMs: number, newestMs: number | null = null): { time: string; rel: string } {
  // ICU may put a narrow no-break space before "pm".
  const time = fmtTime.format(tMs).replace(/\s/g, " ").toLowerCase();
  if (newestMs !== null && tMs > newestMs) {
    return { time, rel: `+${Math.max(1, Math.round((tMs - newestMs) / 60_000))} min forecast` };
  }
  const d = tMs - nowMs;
  if (Math.abs(d) < 60_000) return { time, rel: "now" };
  const sign = d < 0 ? "−" : "+";
  const min = Math.round(Math.abs(d) / 60_000);
  const rel = min < 60
    ? `${sign}${min} min`
    : `${sign}${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
  return { time, rel };
}
