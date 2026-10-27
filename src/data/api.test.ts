import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDay, fetchEarliest, fetchFrame, fetchManifest, fetchMeta } from "./api";

function stub(res: Response) {
  const f = vi.fn(async () => res);
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("fetchManifest hits the relative route and parses JSON", async () => {
    const m = { product: "IDR503", frames: ["202610270000"], lastFetchOk: null, lastError: null };
    const f = stub(Response.json(m));
    expect(await fetchManifest("IDR503")).toEqual(m);
    expect(f).toHaveBeenCalledWith("/api/manifest/IDR503");
  });

  it("fetchFrame returns bytes", async () => {
    const f = stub(new Response(new Uint8Array([1, 2, 3])));
    const out = await fetchFrame("IDR503", "202610270000");
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(f).toHaveBeenCalledWith("/api/frame/IDR503/202610270000");
  });

  it("fetchMeta hits the meta route", async () => {
    const f = stub(Response.json({ product: "IDR503" }));
    await fetchMeta("IDR503");
    expect(f).toHaveBeenCalledWith("/api/meta/IDR503");
  });

  it("fetchDay returns the frames array, and [] on 404", async () => {
    const f = stub(Response.json({ product: "IDR503", day: "20261027", frames: ["a", "b"] }));
    expect(await fetchDay("IDR503", "20261027")).toEqual(["a", "b"]);
    expect(f).toHaveBeenCalledWith("/api/day/IDR503/20261027");
    stub(new Response("nope", { status: 404 }));
    expect(await fetchDay("IDR503", "20261027")).toEqual([]);
  });

  it("fetchEarliest returns the earliest stamp, or null", async () => {
    const f = stub(Response.json({ product: "IDR503", stamp: "202610250100" }));
    expect(await fetchEarliest("IDR503")).toBe("202610250100");
    expect(f).toHaveBeenCalledWith("/api/earliest/IDR503");
    stub(Response.json({ product: "IDR664", stamp: null }));
    expect(await fetchEarliest("IDR664")).toBeNull();
    stub(new Response("x", { status: 500 }));
    await expect(fetchEarliest("IDR503")).rejects.toThrow();
  });

  it("throws on non-2xx", async () => {
    stub(new Response("x", { status: 500 }));
    await expect(fetchManifest("IDR503")).rejects.toThrow();
    stub(new Response("x", { status: 500 }));
    await expect(fetchDay("IDR503", "20261027")).rejects.toThrow();
    stub(new Response("x", { status: 404 }));
    await expect(fetchFrame("IDR503", "202610270000")).rejects.toThrow();
  });
});
