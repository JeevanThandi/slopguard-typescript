/**
 * The CRAP (Change Risk Anti-Patterns) formula.
 *
 *     CRAP(m) = comp(m)² × (1 − cov(m)/100)³ + comp(m)
 *
 * Where:
 *   - `comp` is whatever complexity weighting the caller chooses to feed in.
 *     Since schema 2, slopguard feeds `weightedComplexity =
 *     sqrt(cyclomatic × cognitive)` so the score reflects both raw branching
 *     (cyclomatic) and human-perceived difficulty (cognitive). The formula
 *     itself is metric-agnostic — call sites that explicitly want classic
 *     cyclomatic-driven CRAP can still pass the raw cyclomatic value.
 *   - `cov` is the line coverage percentage in [0, 100].
 *
 * Interpretation:
 *   - Fully covered code (cov = 100) collapses to `comp` — complexity alone.
 *   - Untested code (cov = 0) penalises quadratically: `comp² + comp`.
 *   - The cubed coverage factor sharply rewards even partial test coverage.
 *
 * The default "crappy" threshold is 30, matching the original CRAP paper.
 */

/** Default threshold above which a method/type is considered "crappy". */
export const DEFAULT_CRAP_THRESHOLD = 30.0;

/**
 * Compute the CRAP score for a single unit of code.
 *
 * @param complexity Complexity weighting. Negative values are clamped to 0.
 * @param coveragePercent Coverage in [0, 100]. Out-of-range values are clamped.
 * @returns The CRAP score (always ≥ 0).
 */
export function crapScore(complexity: number, coveragePercent: number): number {
  const comp = Math.max(0, complexity);
  const cov = Math.max(0, Math.min(100, coveragePercent));
  const covFactor = 1 - cov / 100;
  return comp * comp * (covFactor * covFactor * covFactor) + comp;
}

/**
 * Aggregate CRAP for a type by summing per-method CRAP.
 *
 * Three aggregations because each is useful:
 *   - `sum`: total burden of the type — comparable across types.
 *   - `max`: worst single method — drives the "biggest fire" metric.
 *   - `methodCount`: how many methods contributed.
 */
export interface CrapAggregate {
  readonly sum: number;
  readonly max: number;
  readonly methodCount: number;
}

export const ZERO_AGGREGATE: CrapAggregate = { sum: 0, max: 0, methodCount: 0 };

/** Aggregate scores for a collection of method CRAP values. */
export function aggregateCrap(scores: Iterable<number>): CrapAggregate {
  let sum = 0;
  let max = 0;
  let count = 0;
  for (const s of scores) {
    sum += s;
    if (s > max) max = s;
    count += 1;
  }
  return { sum, max, methodCount: count };
}
