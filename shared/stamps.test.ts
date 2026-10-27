import { describe, expect, it } from "vitest";
import { msToStamp, stampToMs } from "./stamps";

describe("stamps", () => {
  it("parses a UTC stamp", () => {
    expect(stampToMs("202610271355")).toBe(Date.UTC(2026, 9, 27, 13, 55));
  });
  it("formats across midnight", () => {
    expect(msToStamp(Date.UTC(2026, 9, 28, 0, 5))).toBe("202610280005");
  });
  it("rejects malformed stamps", () => {
    expect(() => stampToMs("20261027135")).toThrow();
    expect(() => stampToMs("2026102713555")).toThrow();
    expect(() => stampToMs("20261027135x")).toThrow();
    expect(() => stampToMs("202613271355")).toThrow(); // month 13
  });
  it("round-trips", () => {
    expect(msToStamp(stampToMs("202601010000"))).toBe("202601010000");
  });
});
