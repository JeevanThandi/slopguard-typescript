import path from "node:path";
import { Command } from "commander";
import { AnalysisOptions, DEFAULT_EXCLUDE_GLOBS } from "../core/analysis/directoryAnalyzer.js";
import { errorEnvelope, SlopguardError } from "../core/errors.js";
import { errorJSON, errorText } from "../core/formatting/crapReportFormatter.js";
import { jsonMutationReport, prettyMutationReport } from "../core/formatting/mutationReportFormatter.js";
import { MUTATION_OPERATORS, parseOperators } from "../core/mutation/operators.js";
import { SlopguardVersion } from "../core/version.js";
import { expandTilde } from "../coverage/analysisPipeline.js";
import { RunnerKind, SUPPORTED_RUNNERS } from "../coverage/runnerDetection.js";
import { MutationPipeline, MutationRunArgs, TIMEOUT_GRACE_SECONDS } from "../mutation/mutationPipeline.js";
import { resolveProgressReporter } from "./analyze.js";

export interface MutateFlags {
  path: string;
  include: string[];
  exclude: string[];
  defaultExcludes: boolean; // --no-default-excludes sets this false
  operators: string[];
  runner?: string;
  projectDir?: string;
  coverage: boolean; // --no-coverage sets this false
  timeout?: string;
  dryRun: boolean;
  json: boolean;
  failUnder?: string;
  verbose: boolean;
  quiet: boolean;
}

export function makeMutateCommand(): Command {
  const cmd = new Command("mutate");
  cmd
    .description(
      "Mutate the source one change at a time, run the tests against each mutant, and report the mutants the tests miss."
    )
    .addHelpText(
      "after",
      `
Statuses: killed (a test failed), survived (every test passed), timeout,
no_coverage (no test runs the line), compile_error, ignored,
pending (not run: a dry run, or the file changed during the run).
Operators: ${MUTATION_OPERATORS.join(", ")}.
Ignore marker, on the mutated line or on a comment line above it:
  // slopguard-ignore-mutant(boundary): equal values assign the same max

Examples:
  slopguard-ts mutate --path src/store.ts             # one file
  slopguard-ts mutate --path src --include "core/**" --exclude "**/legacy/**"
  slopguard-ts mutate --path src --operators boundary,negate_conditional
  slopguard-ts mutate --path src --dry-run            # list mutants, run nothing
  slopguard-ts mutate --path src --json | jq '.mutants[] | select(.status == "survived")'
  slopguard-ts mutate --path src --fail-under 80      # fail CI below an 80% score`
    )
    .option("-p, --path <path>", "Directory or single source file to mutate. Defaults to the current directory.", ".")
    .option("--include <glob...>", "Only mutate files matching these glob(s). Repeat or pass space-separated.", [])
    .option(
      "--exclude <glob...>",
      "Extra glob(s) of files / directories to skip. Combined with the built-in defaults (node_modules, dist, test files, etc.).",
      []
    )
    .option("--no-default-excludes", "Skip the built-in default excludes.")
    .option(
      "--operators <ids...>",
      "Mutation operators to apply, comma-separated or repeated. Defaults to all.",
      []
    )
    .option(
      "--runner <runner>",
      `Test runner to drive (${SUPPORTED_RUNNERS.join(", ")}). Auto-detected from the project when omitted.`
    )
    .option(
      "--project-dir <dir>",
      "Project directory the test runner executes in. Defaults to the nearest package.json above --path."
    )
    .option(
      "--no-coverage",
      "Skip the coverage run and test every mutant, including mutants on lines no test executes."
    )
    .option(
      "--timeout <seconds>",
      `Per-mutant test timeout in seconds. Defaults to 3 × the baseline run time + ${TIMEOUT_GRACE_SECONDS}.`
    )
    .option("--dry-run", "List the mutants without running any tests.", false)
    .option("--json", "Emit JSON to stdout (default is pretty text).", false)
    .option("--fail-under <score>", "Exit with code 2 if the mutation score (0-100) is below this value. Useful in CI.")
    .option("-v, --verbose", "Stream test-runner output to stderr.", false)
    .option("--quiet", "Suppress all progress chatter on stderr. The report on stdout is unaffected.", false)
    .action(async (flags: MutateFlags) => {
      await runMutate(flags);
    });
  return cmd;
}

/** Validate the flags and turn them into pipeline arguments. Throws `invalid_argument`. */
export function mutateArgsFromFlags(flags: MutateFlags): { args: MutationRunArgs; failUnder: number | null } {
  const timeout = flags.timeout === undefined ? undefined : Number(flags.timeout);
  if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0)) {
    throw SlopguardError.invalidArgument("--timeout", `not a positive number: ${flags.timeout}`);
  }
  const failUnder = flags.failUnder === undefined ? null : Number(flags.failUnder);
  if (failUnder !== null && !Number.isFinite(failUnder)) {
    throw SlopguardError.invalidArgument("--fail-under", `not a number: ${flags.failUnder}`);
  }
  if (flags.runner !== undefined && !SUPPORTED_RUNNERS.includes(flags.runner as RunnerKind)) {
    throw SlopguardError.invalidArgument(
      "--runner",
      `'${flags.runner}' is not supported (expected one of: ${SUPPORTED_RUNNERS.join(", ")})`
    );
  }
  const options: AnalysisOptions = {
    includeGlobs: flags.include,
    excludeGlobs: [...(flags.defaultExcludes ? DEFAULT_EXCLUDE_GLOBS : []), ...flags.exclude],
  };
  return {
    args: {
      sourcePath: path.resolve(expandTilde(flags.path)),
      options,
      operators: parseOperators(flags.operators),
      runner: flags.runner as RunnerKind | undefined,
      projectDir: flags.projectDir === undefined ? undefined : path.resolve(expandTilde(flags.projectDir)),
      coverage: flags.coverage,
      timeoutSeconds: timeout,
      dryRun: flags.dryRun,
      progress: resolveProgressReporter(flags),
    },
    failUnder,
  };
}

export async function runMutate(flags: MutateFlags, pipeline: MutationPipeline = new MutationPipeline()): Promise<void> {
  const emitError = (error: unknown) => {
    const env = errorEnvelope(error);
    process.stderr.write((flags.json ? errorJSON(env) : errorText(env)) + "\n");
    process.exitCode = 1;
  };

  let parsed;
  let report;
  try {
    parsed = mutateArgsFromFlags(flags);
    report = await pipeline.run(parsed.args);
  } catch (error) {
    emitError(error);
    return;
  }

  process.stdout.write(flags.json ? jsonMutationReport(report) + "\n" : prettyMutationReport(report));

  const score = report.summary.mutationScore;
  if (parsed.failUnder !== null && !flags.dryRun && score !== null && score < parsed.failUnder) {
    process.stderr.write(
      `${SlopguardVersion.toolName}: mutation score ${score.toFixed(2)}% is below --fail-under ${parsed.failUnder}\n`
    );
    process.exitCode = 2;
  }
}
