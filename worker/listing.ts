import { PRODUCTS, type ProductId } from "../shared/config";

const FRAME_NAME = /^(IDR\d{3})\.T\.(\d{12})\.png$/;

/**
 * Filters a BOM radar directory listing down to real frames.
 * Accepts bare names or names with a leading path. Anything that is not
 * exactly `IDR{nnn}.T.{YYYYMMDDHHMM}.png` for a known product is ignored
 * (this drops `*.png.tmp` and other stray files).
 *
 * Returns each product that has at least one frame, mapped to its
 * ascending, de-duplicated stamps.
 */
export function parseListing(names: string[]): Map<ProductId, string[]> {
  const byProduct = new Map<ProductId, Set<string>>();

  for (const raw of names) {
    const base = raw.slice(raw.lastIndexOf("/") + 1);
    const match = FRAME_NAME.exec(base);
    if (!match) continue;

    const product = match[1] as ProductId;
    const stamp = match[2];
    if (!stamp || !PRODUCTS.includes(product)) continue;

    let stamps = byProduct.get(product);
    if (!stamps) {
      stamps = new Set<string>();
      byProduct.set(product, stamps);
    }
    stamps.add(stamp);
  }

  const result = new Map<ProductId, string[]>();
  for (const product of PRODUCTS) {
    const stamps = byProduct.get(product);
    if (stamps && stamps.size > 0) {
      // YYYYMMDDHHMM is fixed-width digits, so lexicographic sort is chronological.
      result.set(product, [...stamps].sort());
    }
  }
  return result;
}
