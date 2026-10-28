import { handleApi } from "./api";
import { openBomFtp } from "./ftp";
import { runIngest } from "./ingest";

export interface Env {
  BUCKET: R2Bucket;
}

type Radar = "marburg" | "stapylton";

/** One NLST for all four products of a radar (verified against ftp.bom.gov.au). */
export function radarGlob(radar: Radar): string {
  return `/anon/gen/radar/${radar === "marburg" ? "IDR50" : "IDR66"}[1-4].T.*.png`;
}

/** True in UTC minute 0 of each hour: both radars check their map files hourly. */
export function shouldRefreshMeta(scheduledTimeMs: number): boolean {
  return Math.floor(scheduledTimeMs / 60_000) % 60 === 0;
}

/** One radar's ingest on its own FTP connection. Never throws, so one radar failing can't stop the other. */
async function ingestRadar(radar: Radar, bucket: R2Bucket, scheduledTime: number): Promise<string> {
  let ftp;
  try {
    ftp = await openBomFtp();
  } catch (e) {
    return `${radar} ftp open failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    const r = await runIngest({
      ftp,
      bucket,
      nowMs: Date.now(),
      radar,
      radarGlob: radarGlob(radar),
      refreshMeta: shouldRefreshMeta(scheduledTime),
    });
    const added = Object.values(r.added).reduce((n, c) => n + c, 0);
    return `${radar} +${added}${r.errors.length ? " " + r.errors.join("; ") : ""}`;
  } catch (e) {
    return `${radar} ingest failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await ftp.close().catch(() => {});
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) return handleApi(request, env.BUCKET, Date.now());
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },

  /** Every minute: both radars in parallel, one log line. */
  async scheduled(event, env, ctx): Promise<void> {
    ctx.waitUntil(
      Promise.all((["marburg", "stapylton"] as const).map((radar) => ingestRadar(radar, env.BUCKET, event.scheduledTime))).then(
        (lines) => console.log(lines.join(" | ")),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
