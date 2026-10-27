import { RADARS, type ProductId } from "../shared/config";
import { handleApi } from "./api";
import { openBomFtp } from "./ftp";
import { runIngest } from "./ingest";

export interface Env {
  BUCKET: R2Bucket;
}

/** Even UTC minutes poll Marburg, odd minutes Mt Stapylton (halves per-invocation CPU). */
export function productsForMinute(scheduledTimeMs: number): ProductId[] {
  const minute = Math.floor(scheduledTimeMs / 60_000);
  return minute % 2 === 0 ? RADARS.marburg.products : RADARS.stapylton.products;
}

/** One NLST for all four products of a radar (verified against ftp.bom.gov.au). */
export function radarGlob(radar: "marburg" | "stapylton"): string {
  return `/anon/gen/radar/${radar === "marburg" ? "IDR50" : "IDR66"}[1-4].T.*.png`;
}

/** True in UTC minutes 0 and 1, so each radar (even/odd minute) checks its map files hourly. */
export function shouldRefreshMeta(scheduledTimeMs: number): boolean {
  return Math.floor(scheduledTimeMs / 60_000) % 60 < 2;
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

  async scheduled(event, env, ctx): Promise<void> {
    const products = productsForMinute(event.scheduledTime);
    ctx.waitUntil(
      (async () => {
        let ftp;
        try {
          ftp = await openBomFtp();
        } catch (e) {
          console.error(`ftp open failed: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        try {
          const radar = products === RADARS.marburg.products ? "marburg" : "stapylton";
          const r = await runIngest({
            ftp,
            bucket: env.BUCKET,
            nowMs: Date.now(),
            radar,
            radarGlob: radarGlob(radar),
            refreshMeta: shouldRefreshMeta(event.scheduledTime),
          });
          const added = products.reduce((n, p) => n + r.added[p], 0);
          console.log(`${products[0]} +${added}${r.errors.length ? " " + r.errors.join("; ") : ""}`);
        } catch (e) {
          console.error(`ingest failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          await ftp.close().catch(() => {});
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
