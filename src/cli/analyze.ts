import path from "node:path";
import { Command } from "commander";
import {
  defaultAnalysisOptions,
  DEFAULT_EXCLUDE_GLOBS,
} from "../core/analysis/directoryAnalyzer.js";
import { DEFAULT_CRAP_THRESHOLD } from "../core/crap.js";
import { errorEnvelope, SlopguardError } from "../core/errors.js";
import {
  errorJSON,
  errorText,
  jsonReport,
  prettyReport,
} from "../core/formatting/crapReportFormatter.js";
import { ProgressReporter } from "../core/progressReporter.js";
import { SlopguardVersion } from "../core/version.js";
import {
  AnalysisPipeline,
  coverageSourceFromFlags,
  expandTilde,
} from "../coverage/analysisPipeline.js";
import { RunnerKind, SUPPORTED_RUNNERS } from "../coverage/runnerDetection.js";

export interface AnalyzeFlags {
  path: string;
  threshold: string;
  runner?: string;
  projectDir?: string;
  coverage: boolean; // commander's --no-coverage sets this false
  coverageFile?: string;
  include: string[];
  exclude: string[];
  defaultExcludes: boolean; // --no-default-excludes sets this false
  json: boolean;
  failOver?: string;
  verbose: boolean;
  quiet: boolean;
}

/**
 * `--quiet` wins over `--verbose` if both are passed; if neither is passed we
 * emit the default phase markers. Exported so tests can assert the
 * flag → verbosity mapping.
 */
export function resolveProgressReporter(flags: Pick<AnalyzeFlags, "verbose" | "quiet">): ProgressReporter {
  if (flags.quiet) return ProgressReporter.silent;
  return ProgressReporter.stderr(flags.verbose ? "verbose" : "normal");
}

export function makeAnalyzeCommand(): Command {
  const cmd = new Command("analyze");
  cmd
    .description("Analyze a directory or file and print a CRAP report.")
    .addHelpText(
      "after",
      `
slopguard-ts drives the project's own test runner (vitest or jest) with a
forced json coverage reporter to gather line coverage. Coverage is an
artifact of the analysis, not an input.

Examples:
  slopguard-ts analyze --path src --threshold 30 --json
  slopguard-ts analyze --path src --runner vitest        # skip auto-detection
  slopguard-ts analyze --path . --project-dir packages/core  # monorepo package
  slopguard-ts analyze --path . --fail-over 50           # fail CI when any method's CRAP > 50
  slopguard-ts analyze --path src --no-coverage          # skip the test run (complexity-only)
  slopguard-ts analyze --path src --coverage-file coverage/coverage-final.json  # pre-built istanbul data`
    )
    .option(
      "-p, --path <path>",
      "Directory of TypeScript/JavaScript sources, or a single source file. Defaults to the current directory.",
      "."
    )
    .option(
      "-t, --threshold <number>",
      "CRAP threshold above which a method/type is considered crappy.",
      String(DEFAULT_CRAP_THRESHOLD)
    )
    .option(
      "--runner <runner>",
      `Test runner to drive for coverage (${SUPPORTED_RUNNERS.join(", ")}). Auto-detected from the project when omitted.`
    )
    .option(
      "--project-dir <dir>",
      "Project directory the test runner executes in. Defaults to the nearest package.json above --path."
    )
    .option(
      "--no-coverage",
      "Skip the test run and report complexity only (every method shows 0% coverage)."
    )
    .option(
      "--coverage-file <path>",
      "Pre-built istanbul coverage-final.json to join instead of running tests. Escape hatch for runners slopguard can't drive (nyc, c8, mocha) or CI that already produced coverage."
    )
    .option("--include <glob...>", "Glob(s) of files to include. Repeat or pass space-separated.", [])
    .option(
      "--exclude <glob...>",
      "Extra glob(s) of files / directories to exclude. Combined with the built-in defaults (node_modules, dist, *.test.*, *.spec.*, __tests__, etc.) — use --no-default-excludes to start clean.",
      []
    )
    .option(
      "--no-default-excludes",
      "Skip the built-in default excludes. Useful when you want to analyze test code itself, or take complete manual control of the exclude list."
    )
    .option("--json", "Emit JSON to stdout (default is pretty text).", false)
    .option(
      "--fail-over <number>",
      "Exit with code 2 if any method's CRAP exceeds this value. Useful in CI."
    )
    .option(
      "-v, --verbose",
      "Stream test-runner output and other subprocess chatter to stderr. Use when you suspect the test run itself is misbehaving.",
      false
    )
    .option(
      "--quiet",
      "Suppress all progress chatter on stderr. Phase markers and subprocess output are silenced. JSON / pretty output on stdout is unaffected.",
      false
    )
    .action(async (flags: AnalyzeFlags) => {
      await runAnalyze(flags);
    });
  return cmd;
}

export async function runAnalyze(flags: AnalyzeFlags): Promise<void> {
  const json = flags.json;
  const emitError = (error: unknown) => {
    const env = errorEnvelope(error);
    process.stderr.write((json ? errorJSON(env) : errorText(env)) + "\n");
  };

  const threshold = Number(flags.threshold);
  if (!Number.isFinite(threshold)) {
    emitError(SlopguardError.invalidArgument("--threshold", `not a number: ${flags.threshold}`));
    process.exitCode = 1;
    return;
  }
  const failOver = flags.failOver === undefined ? null : Number(flags.failOver);
  if (failOver !== null && !Number.isFinite(failOver)) {
    emitError(SlopguardError.invalidArgument("--fail-over", `not a number: ${flags.failOver}`));
    process.exitCode = 1;
    return;
  }
  if (flags.runner !== undefined && !SUPPORTED_RUNNERS.includes(flags.runner as RunnerKind)) {
    emitError(
      SlopguardError.invalidArgument(
        "--runner",
        `'${flags.runner}' is not supported (expected one of: ${SUPPORTED_RUNNERS.join(", ")})`
      )
    );
    process.exitCode = 1;
    return;
  }

  const baseExcludes = flags.defaultExcludes ? [...DEFAULT_EXCLUDE_GLOBS] : [];
  const options = {
    includeGlobs: flags.include,
    excludeGlobs: [...baseExcludes, ...flags.exclude],
  };
  const coverage = coverageSourceFromFlags({
    noCoverage: !flags.coverage,
    coverageFile: flags.coverageFile,
    runner: flags.runner as RunnerKind | undefined,
    projectDir: flags.projectDir,
  });
  const progress = resolveProgressReporter(flags);
  const sourcePath = path.resolve(expandTilde(flags.path));

  const pipeline = new AnalysisPipeline();
  let report;
  try {
    report = await pipeline.run({
      sourcePath,
      coverage,
      threshold,
      options: options.includeGlobs.length > 0 || options.excludeGlobs.length > 0
        ? options
        : defaultAnalysisOptions(),
      progress,
    });
  } catch (error) {
    emitError(error);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(json ? jsonReport(report) + "\n" : prettyReport(report));

  const worst = report.methods[0];
  if (failOver !== null && worst !== undefined && worst.crap > failOver) {
    process.stderr.write(
      `${SlopguardVersion.toolName}: CRAP ${worst.crap} exceeds --fail-over ${failOver}\n`
    );
    process.exitCode = 2;
  }
}
