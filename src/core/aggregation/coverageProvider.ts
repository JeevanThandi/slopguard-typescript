/**
 * Abstraction over coverage data, so the core does not depend on the coverage
 * subsystem (which spawns test runners). The coverage module supplies a
 * concrete implementation via `CoverageIndex`.
 */
export interface CoverageProvider {
  /** Method-level coverage as a percentage in [0, 100], or null if unknown. */
  methodCoverage(absolutePath: string, line: number, endLine: number): number | null;

  /** File-level coverage as a percentage in [0, 100], or null if unknown. */
  fileCoverage(absolutePath: string): number | null;
}
