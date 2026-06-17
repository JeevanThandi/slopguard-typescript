/**
 * Why a coverage run came back empty. These cases look identical from the
 * outside (no usable coverage data) but mean very different things to the
 * user — `no_tests_detected` is an honest 0%, while `coverage_not_gathered`
 * is a configuration problem masquerading as 0%.
 */
export type CoverageMissingReason =
  | { kind: "no_tests_detected" }
  | { kind: "coverage_not_gathered"; testCount: number | null };

export type SlopguardErrorCode =
  | "file_not_found"
  | "not_a_directory"
  | "unreadable_file"
  | "parse_failed"
  | "coverage_data_missing"
  | "runner_unavailable"
  | "runner_ambiguous"
  | "runner_not_detected"
  | "test_run_failed"
  | "coverage_decode_failed"
  | "invalid_argument"
  | "unsupported"
  | "internal_error";

/**
 * Machine-readable error type. Every instance carries a stable string `code`
 * so that CLI `--json` output stays consumable by agents without
 * pattern-matching on free-text messages.
 */
export class SlopguardError extends Error {
  readonly code: SlopguardErrorCode;

  constructor(code: SlopguardErrorCode, message: string) {
    super(message);
    this.name = "SlopguardError";
    this.code = code;
  }

  override toString(): string {
    return `[${this.code}] ${this.message}`;
  }

  static fileNotFound(path: string): SlopguardError {
    return new SlopguardError("file_not_found", `File not found: ${path}`);
  }

  static notADirectory(path: string): SlopguardError {
    return new SlopguardError("not_a_directory", `Not a directory: ${path}`);
  }

  static unreadableFile(path: string, underlying: string): SlopguardError {
    return new SlopguardError("unreadable_file", `Could not read ${path}: ${underlying}`);
  }

  static parseFailed(path: string, underlying: string): SlopguardError {
    return new SlopguardError("parse_failed", `Failed to parse ${path}: ${underlying}`);
  }

  static coverageDataMissing(reason: CoverageMissingReason): SlopguardError {
    if (reason.kind === "no_tests_detected") {
      return new SlopguardError("coverage_data_missing", "No tests were detected in the coverage run");
    }
    const detail =
      reason.testCount != null ? `${reason.testCount} test(s) ran` : "tests appear to have run";
    return new SlopguardError(
      "coverage_data_missing",
      `${detail} but no coverage data was gathered — check the test runner's coverage configuration`
    );
  }

  static runnerUnavailable(reason: string): SlopguardError {
    return new SlopguardError("runner_unavailable", `Test runner is unavailable: ${reason}`);
  }

  static runnerAmbiguous(runners: string[]): SlopguardError {
    return new SlopguardError(
      "runner_ambiguous",
      `Multiple test runners detected; pass --runner to disambiguate. Detected: ${runners.join(", ")}`
    );
  }

  static runnerNotDetected(projectDirectory: string): SlopguardError {
    return new SlopguardError(
      "runner_not_detected",
      `No supported test runner (vitest, jest) was detected under ${projectDirectory}. ` +
        `Pass --runner <vitest|jest>, --coverage-file <coverage-final.json>, or --no-coverage.`
    );
  }

  static testRunFailed(exitCode: number, stderr: string): SlopguardError {
    return new SlopguardError(
      "test_run_failed",
      `Test runner failed before coverage was produced (exit ${exitCode}): ${stderr}`
    );
  }

  static coverageDecodeFailed(underlying: string): SlopguardError {
    return new SlopguardError("coverage_decode_failed", `Failed to decode coverage data: ${underlying}`);
  }

  static invalidArgument(name: string, reason: string): SlopguardError {
    return new SlopguardError("invalid_argument", `Invalid argument '${name}': ${reason}`);
  }

  static unsupported(reason: string): SlopguardError {
    return new SlopguardError("unsupported", `Unsupported: ${reason}`);
  }
}

/** JSON-friendly envelope emitted on the CLI's `--json` error path. */
export interface SlopguardErrorEnvelope {
  readonly code: string;
  readonly message: string;
}

export function errorEnvelope(error: unknown): SlopguardErrorEnvelope {
  if (error instanceof SlopguardError) {
    return { code: error.code, message: error.message };
  }
  return { code: "internal_error", message: String(error) };
}
