/**
 * Data models for `mutate`. Pure data plus the scoring maths — no I/O.
 */
import { MutationOperator } from "./operators.js";

/**
 * What happened to a mutant.
 *
 * - `killed` — the tests failed with the mutant in place (good).
 * - `survived` — the tests still passed (a gap: no test checks this behaviour).
 * - `timeout` — the test run exceeded the timeout; counted as killed.
 * - `no_coverage` — no test executes the mutated line, so it was not run.
 * - `compile_error` — the mutant did not compile; excluded from the score.
 * - `ignored` — switched off by a `slopguard-ignore-mutant` marker.
 * - `pending` — listed by `--dry-run`, never run.
 */
export type MutantStatus =
  | "killed"
  | "survived"
  | "timeout"
  | "no_coverage"
  | "compile_error"
  | "ignored"
  | "pending";

/**
 * One planned source change, before any test run. `start`/`end` index the
 * file's source string (UTF-16 code units); `line` and `column` are 1-based,
 * with `column` counted in Unicode code points.
 */
export interface MutantSite {
  /** Path relative to the source root (forward-slash-normalized). */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly operator: MutationOperator;
  /** The exact source text the mutant replaces. */
  readonly original: string;
  /** The exact text written in its place. */
  readonly replacement: string;
  readonly start: number;
  readonly end: number;
}

/** A mutant in the final report. */
export interface MutantResult {
  /** Stable id: `<file>:<line>:<column>:<operator>`. */
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly operator: MutationOperator;
  readonly original: string;
  readonly replacement: string;
  /** Qualified name of the innermost enclosing method, or null for top-level code. */
  readonly method: string | null;
  readonly status: MutantStatus;
}

export interface MutationSummary {
  /** Source files scanned, including files that yielded no mutants. */
  readonly fileCount: number;
  readonly mutantCount: number;
  readonly killed: number;
  readonly survived: number;
  readonly timedOut: number;
  readonly noCoverage: number;
  readonly compileErrors: number;
  readonly ignored: number;
  readonly pending: number;
  /**
   * `(killed + timedOut) / (killed + timedOut + survived + noCoverage) × 100`,
   * or null when no mutant counts towards the score.
   */
  readonly mutationScore: number | null;
}

/**
 * Top-level JSON payload of `mutate --json`. Versioned separately from the
 * CRAP report (`reportType` tells the two apart). Shared with every port.
 */
export interface MutationReport {
  readonly schemaVersion: string;
  readonly reportType: "mutation";
  readonly tool: string;
  readonly toolVersion: string;
  readonly generatedAt: string;
  readonly sourceRoot: string;
  /** Where the tests ran; null in a dry run. */
  readonly projectRoot: string | null;
  /** The test runner driven for mutants; null in a dry run. */
  readonly runner: string | null;
  /** Per-mutant timeout; null in a dry run. */
  readonly timeoutSeconds: number | null;
  /** Whether line coverage classified `no_coverage` mutants. */
  readonly coverageAvailable: boolean;
  readonly operators: MutationOperator[];
  readonly notes: string[];
  readonly summary: MutationSummary;
  readonly mutants: MutantResult[];
}

export const MUTATION_SCHEMA_VERSION = "1";

export function mutantId(site: Pick<MutantSite, "file" | "line" | "column" | "operator">): string {
  return `${site.file}:${site.line}:${site.column}:${site.operator}`;
}

/** Report order: file, then line, column and operator id. */
export function compareSites(
  a: Pick<MutantSite, "file" | "line" | "column" | "operator">,
  b: Pick<MutantSite, "file" | "line" | "column" | "operator">
): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1; // slopguard-ignore-mutant(boundary): the files differ here, so < and <= agree
  if (a.line !== b.line) return a.line - b.line;
  if (a.column !== b.column) return a.column - b.column;
  return a.operator < b.operator ? -1 : a.operator > b.operator ? 1 : 0;
}

/** The source with one mutant applied. */
export function applyMutant(source: string, site: Pick<MutantSite, "start" | "end" | "replacement">): string {
  return source.slice(0, site.start) + site.replacement + source.slice(site.end);
}

export function summarize(mutants: readonly MutantResult[], fileCount: number): MutationSummary {
  const count = (status: MutantStatus) => mutants.filter((m) => m.status === status).length;
  const killed = count("killed");
  const timedOut = count("timeout");
  const survived = count("survived");
  const noCoverage = count("no_coverage");
  const detected = killed + timedOut;
  const scored = detected + survived + noCoverage;
  return {
    fileCount,
    mutantCount: mutants.length,
    killed,
    survived,
    timedOut,
    noCoverage,
    compileErrors: count("compile_error"),
    ignored: count("ignored"),
    pending: count("pending"),
    mutationScore: scored === 0 ? null : (detected / scored) * 100,
  };
}
