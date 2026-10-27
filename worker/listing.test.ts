import { describe, expect, it } from "vitest";
import { parseListing } from "./listing";

describe("parseListing", () => {
  it("keeps only real frames for known products, ascending", () => {
    const m = parseListing([
      "IDR503.T.202610270549.png",
      "IDR503.T.202610270544.png",
      "IDR712.T.202110092349.png.tmp",
      "IDR503.T.202610270554.png.tmp",
      "IDR713.T.202610270549.png",
      "IDR503.gif",
    ]);
    expect(m.get("IDR503")).toEqual(["202610270544", "202610270549"]);
    expect([...m.keys()]).toEqual(["IDR503"]);
  });

  it("strips a leading path from each name", () => {
    const m = parseListing([
      "/anon/gen/radar/IDR504.T.202610270600.png",
      "anon/gen/radar/IDR504.T.202610270555.png",
    ]);
    expect(m.get("IDR504")).toEqual(["202610270555", "202610270600"]);
  });

  it("removes duplicate stamps", () => {
    const m = parseListing([
      "IDR501.T.202610270500.png",
      "IDR501.T.202610270500.png",
    ]);
    expect(m.get("IDR501")).toEqual(["202610270500"]);
  });

  it("accepts Mt Stapylton products", () => {
    const m = parseListing(["IDR663.T.202610270549.png"]);
    expect(m.get("IDR663")).toEqual(["202610270549"]);
  });

  it("rejects names with the wrong stamp or product shape", () => {
    const m = parseListing([
      "IDR503.T.20261027054.png", // 11 digits
      "IDR503.T.2026102705491.png", // 13 digits
      "IDR50.T.202610270549.png", // 2-digit product
      "IDR503.T.202610270549.PNG", // wrong case
      "xIDR503.T.202610270549.png", // prefix garbage
    ]);
    expect(m.size).toBe(0);
  });

  it("omits products with no frames", () => {
    const m = parseListing(["IDR502.T.202610270549.png.tmp"]);
    expect(m.has("IDR502")).toBe(false);
    expect(m.size).toBe(0);
  });

  it("returns an empty map for an empty listing", () => {
    expect(parseListing([]).size).toBe(0);
  });
});
