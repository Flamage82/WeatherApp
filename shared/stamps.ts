const STAMP_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/;

/** Parse a BOM `YYYYMMDDHHMM` (UTC) stamp to epoch ms. Throws on malformed or impossible input. */
export function stampToMs(s: string): number {
  const m = STAMP_RE.exec(s);
  if (!m) throw new Error(`Invalid stamp: ${JSON.stringify(s)}`);
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d ||
    back.getUTCHours() !== h ||
    back.getUTCMinutes() !== mi
  ) {
    throw new Error(`Invalid stamp: ${JSON.stringify(s)}`);
  }
  return ms;
}

/** Format epoch ms as a `YYYYMMDDHHMM` (UTC) stamp. Seconds are dropped. */
export function msToStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes())
  );
}
