// No @types/node in this project; vitest runs in Node so the import works at runtime.
// @ts-ignore TS2591
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CELL_SIZE, PRODUCTS, type ProductId } from "./config";
import { decodeFrame, type LevelField } from "./decodeFrame";

/** One rainy real frame per product (2026-10-27), see the CELL_SIZE comment. */
const FIXTURES: Record<ProductId, string> = {
  IDR501: "IDR501.T.202610270856.png",
  IDR502: "IDR502.T.202610270829.png",
  IDR503: "IDR503.T.202610270804.png",
  IDR504: "IDR504.T.202610270559.png",
  IDR661: "IDR661.T.202610270856.png",
  IDR662: "IDR662.T.202610270859.png",
  IDR663: "IDR663.T.202610270624.png",
  IDR664: "IDR664.T.202610270559.png",
};

const load = (file: string): LevelField =>
  decodeFrame(new Uint8Array((readFileSync as (u: URL) => Uint8Array)(new URL(`./__fixtures__/cells/${file}`, import.meta.url))));

/** Equal-adjacent-pair rate among rain pairs, by pair start position mod 4 (horizontal + vertical). */
function pairRates(f: LevelField): number[] {
  const eq = [0, 0, 0, 0], n = [0, 0, 0, 0];
  const d = f.data;
  for (let y = 0; y < 512; y++)
    for (let x = 0; x < 512; x++) {
      const a = d[y * 512 + x]!;
      if (x < 511) {
        const b = d[y * 512 + x + 1]!;
        if (a || b) { n[x % 4]!++; if (a === b) eq[x % 4]!++; }
      }
      if (y < 511) {
        const b = d[(y + 1) * 512 + x]!;
        if (a || b) { n[y % 4]!++; if (a === b) eq[y % 4]!++; }
      }
    }
  return eq.map((e, i) => e / n[i]!);
}

/** Largest k in {4, 2, 1} (phase 0) whose within-cell pairs are (nearly) always equal. */
function measureCellSize(f: LevelField): number {
  const r = pairRates(f);
  const within = (k: number) => [0, 1, 2, 3].filter((m) => m % k !== k - 1);
  for (const k of [4, 2]) if (within(k).every((m) => r[m]! >= 0.98)) return k;
  return 1;
}

describe("CELL_SIZE", () => {
  it("has an entry for every product", () => {
    for (const p of PRODUCTS) expect([1, 2, 4]).toContain(CELL_SIZE[p]);
  });

  for (const p of PRODUCTS) {
    it(`${p}: measured native cell size matches the table (phase 0)`, () => {
      const f = load(FIXTURES[p]);
      const r = pairRates(f);
      expect(measureCellSize(f)).toBe(CELL_SIZE[p]);
      // Phase 0: cell boundaries fall between odd x and even x+1, so pairs starting odd differ often.
      if (CELL_SIZE[p] === 2) {
        expect(r[1]!).toBeLessThan(0.8);
        expect(r[3]!).toBeLessThan(0.8);
      }
    });
  }
});
