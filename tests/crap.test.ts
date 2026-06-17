import { describe, expect, it } from "vitest";
import { aggregateCrap, crapScore, DEFAULT_CRAP_THRESHOLD } from "../src/core/crap.js";

describe("crapScore", () => {
  it("collapses to complexity at full coverage", () => {
    expect(crapScore(20, 100)).toBe(20);
    expect(crapScore(1, 100)).toBe(1);
  });

  it("penalises untested code quadratically", () => {
    // cov = 0: comp² + comp
    expect(crapScore(20, 0)).toBe(420);
    expect(crapScore(5, 0)).toBe(30);
  });

  it("rewards partial coverage cubically", () => {
    // comp=10, cov=50: 100 × 0.125 + 10 = 22.5
    expect(crapScore(10, 50)).toBeCloseTo(22.5);
  });

  it("clamps negative complexity to zero", () => {
    expect(crapScore(-5, 0)).toBe(0);
  });

  it("clamps out-of-range coverage", () => {
    expect(crapScore(10, 150)).toBe(10);
    expect(crapScore(10, -50)).toBe(110);
  });

  it("uses the classic threshold of 30", () => {
    expect(DEFAULT_CRAP_THRESHOLD).toBe(30);
  });
});

describe("aggregateCrap", () => {
  it("returns zero for an empty sequence", () => {
    expect(aggregateCrap([])).toEqual({ sum: 0, max: 0, methodCount: 0 });
  });

  it("sums, maxes, and counts", () => {
    expect(aggregateCrap([1, 5, 3])).toEqual({ sum: 9, max: 5, methodCount: 3 });
  });
});
