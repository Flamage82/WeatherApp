import type { ProductId } from "../../shared/config";
import type { Manifest, RadarGeometry } from "../../shared/types";

async function getOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res;
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
  const url = `/api/day/${p}/${day}`;
  const res = await fetch(url);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return ((await res.json()) as { frames: string[] }).frames;
}
