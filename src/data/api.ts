import type { ProductId } from "../../shared/config";
import type { Manifest, RadarGeometry, SeriesDay } from "../../shared/types";

/** Every request is abandoned after this, so a hung fetch can't hold up a refresh or a day listing. */
export const FETCH_TIMEOUT_MS = 15_000;

const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

async function getOk(url: string): Promise<Response> {
  const res = await get(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res;
}

/** JSON body of `url`, or null on 404. */
async function getJsonOr404<T>(url: string): Promise<T | null> {
  const res = await get(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json();
}

export async function fetchManifest(p: ProductId): Promise<Manifest> {
  return (await getOk(`/api/manifest/${p}`)).json();
}

export async function fetchFrame(p: ProductId, stamp: string): Promise<Uint8Array> {
  return new Uint8Array(await (await getOk(`/api/frame/${p}/${stamp}`)).arrayBuffer());
}

export async function fetchMeta(p: ProductId): Promise<RadarGeometry> {
  return (await getOk(`/api/meta/${p}`)).json();
}

/** The product's earliest archived stamp (YYYYMMDDHHMM), or null if it has no frames: the scroll-back floor. */
export async function fetchEarliest(p: ProductId): Promise<string | null> {
  return ((await (await getOk(`/api/earliest/${p}`)).json()) as { stamp: string | null }).stamp;
}

/** Ascending stamps (YYYYMMDDHHMM) for one UTC day (`day` = YYYYMMDD); `[]` on 404. */
export async function fetchDay(p: ProductId, day: string): Promise<string[]> {
  return (await getJsonOr404<{ frames: string[] }>(`/api/day/${p}/${day}`))?.frames ?? [];
}

/** Rain level at home per frame for one UTC day (`day` = YYYYMMDD); no points on 404. */
export async function fetchSeries(p: ProductId, day: string): Promise<SeriesDay> {
  return (await getJsonOr404<SeriesDay>(`/api/series/${p}/${day}`)) ?? { product: p, day, points: [] };
}
