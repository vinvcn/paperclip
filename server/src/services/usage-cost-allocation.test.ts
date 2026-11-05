import { describe, expect, it } from "vitest";
import { allocateUnitsByWeight } from "./usage-request-logs.js";

/**
 * The cost-attribution allocator (docs/specs/usage-request-logs.md, Cost
 * attribution): pure integer math so a run's receipt can be split across its
 * request rows with no rounding drift. The minimum unit is the numeric(24,7)
 * storage scale (1e-7 cents), so exact sums are assertable as BigInts.
 */
describe("allocateUnitsByWeight", () => {
  it("splits proportionally when the receipt divides evenly", () => {
    // 1.00 cent = 10,000,000 units across weights 3:1.
    expect(allocateUnitsByWeight(10_000_000n, [300, 100])).toEqual([7_500_000n, 2_500_000n]);
  });

  it("sums exactly to the receipt even when every share needs rounding", () => {
    // One minimum unit cannot be split three ways: floor gives 0 everywhere
    // and the remainder must land on the largest weight.
    const shares = allocateUnitsByWeight(1n, [2, 2, 2]);
    expect(shares.reduce((sum, share) => sum + share, 0n)).toBe(1n);
    expect(shares).toEqual([1n, 0n, 0n]);
  });

  it("keeps the total invariant across awkward weights", () => {
    for (const [total, weights] of [
      [1234567n, [1, 2, 3, 5, 8, 13]],
      [999999n, [7, 7, 7]],
      [10n, [1, 1, 1, 1, 1, 1, 1]],
      [1n, [1_000_000]],
      [5n, [] as number[]],
    ] as const) {
      const shares = allocateUnitsByWeight(total, [...weights]);
      expect(shares.reduce((sum, share) => sum + share, 0n)).toBe(weights.length === 0 ? 0n : total);
      expect(shares).toHaveLength(weights.length);
      for (const share of shares) expect(share >= 0n).toBe(true);
    }
  });

  it("gives rounding remainders to the largest weights first", () => {
    // 10 units over weights 1,1,1: floors 3/3/3 with one unit left, which
    // goes to the first largest weight (the tie keeps the original order).
    expect(allocateUnitsByWeight(10n, [1, 1, 1])).toEqual([4n, 3n, 3n]);
    // An actual larger weight wins the remainder over equal floors:
    // floors are 5/2/2 and the leftover unit lands on the weight-2 row.
    expect(allocateUnitsByWeight(10n, [2, 1, 1])).toEqual([6n, 2n, 2n]);
  });

  it("distributes nothing for a zero receipt and treats zero weights as absent", () => {
    expect(allocateUnitsByWeight(0n, [5, 5])).toEqual([0n, 0n]);
    // Zero weights never receive share even when others absorb the receipt.
    expect(allocateUnitsByWeight(100n, [0, 10, 0, 10])).toEqual([0n, 50n, 0n, 50n]);
    expect(allocateUnitsByWeight(100n, [0, 0])).toEqual([0n, 0n]);
  });
});
