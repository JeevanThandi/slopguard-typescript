import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AnalysisOptions,
  defaultAnalysisOptions,
  DirectoryAnalyzer,
} from "../core/analysis/directoryAnalyzer.js";
import { errorEnvelope, SlopguardError } from "../core/errors.js";
import { errorText } from "../core/formatting/crapReportFormatter.js";
import {
  applyMutant,
  MUTATION_SCHEMA_VERSION,
  MutantResult,
  MutantStatus,
  MutationReport,
  mutantId,
  summarize,
} from "../core/mutation/models.js";
import { MutationPlanner, PlannedMutant } from "../core/mutation/mutationPlanner.js";
import { MUTATION_OPERATORS, MutationOperator } from "../core/mutation/operators.js";
import { ProgressReporter } from "../core/progressReporter.js";
import { SlopguardVersion } from "../core/version.js";
import { loadCoverageIndex } from "../coverage/analysisPipeline.js";
import { CoverageIndex } from "../coverage/coverageIndex.js";
import { discoverProjectRoot } from "../coverage/projectRootDiscovery.js";
import { detectRunner, runnerBinary, RunnerKind } from "../coverage/runnerDetection.js";
import { TestRunner, TestRunOutcome } from "../coverage/testRunner.js";
import { CommandOutcome, CommandRunner, mutantTestArguments } from "./commandRunner.js";
import { GuardOptions, SourceChangedError, WorkspaceGuard } from "./workspaceGuard.js";

/** Added to three times the baseline run time to form the default per-mutant timeout. */
export const TIMEOUT_GRACE_SECONDS = 10;

/** Exit codes for the signals that interrupt a run (128 + signal number). */
export const SIGNAL_EXIT_CODES: Readonly<Record<"SIGHUP" | "SIGINT" | "SIGTERM", number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export const NOTE_NO_COVERAGE = "The baseline test run produced no coverage data, so every mutant was run.";
export const NOTE_ALL_SURVIVED =
  "Every tested mutant survived. Check that the tests import the source under --path.";

/** A TypeScript type-check diagnostic, as ts-jest prints it. */
const TYPE_ERROR = /error TS\d+:/;
/** The header jest prints above a suite that could not run (ts-jest type errors land here). */
const SUITE_FAILED = "Test suite failed to run";

/** The process hooks the pipeline needs for signal handling. Injectable for tests. */
export interface ProcessHooks {
  on(signal: NodeJS.Signals, handler: () => void): void;
  off(signal: NodeJS.Signals, handler: () => void): void;
  exit(code: number): void;
  /** Report a failure that must be seen even under `--quiet`. */
  stderr(line: string): void;
}

const nodeProcessHooks: ProcessHooks = {
  on: (signal, handler) => process.on(signal, handler),
  off: (signal, handler) => process.off(signal, handler),
  exit: (code) => process.exit(code),
  stderr: (line) => process.stderr.write(line + "\n"),
};

export interface MutationRunArgs {
  /** Directory or single source file to mutate. */
  sourcePath: string;
  options?: AnalysisOptions;
  /** Operators to apply. Default: all. */
  operators?: readonly MutationOperator[];
  /** Explicit runner; auto-detected from the project when omitted. */
  runner?: RunnerKind;
  /** Where the tests run; discovered from the source path when omitted. */
  projectDir?: string;
  /** Classify mutants on untested lines as `no_coverage` (default true). */
  coverage?: boolean;
  /** Per-mutant timeout; computed from the baseline when omitted. */
  timeoutSeconds?: number;
  /** List mutants without running tests. */
  dryRun?: boolean;
  progress?: ProgressReporter;
}

interface PlannedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  /** The bytes the mutants were planned from. */
  readonly bytes: Buffer;
  readonly source: string;
  readonly mutants: PlannedMutant[];
}

interface Execution {
  /** The files as planned for the run (re-planned if the guard restored a file). */
  readonly files: PlannedFile[];
  readonly projectRoot: string;
  readonly runner: RunnerKind;
  readonly timeoutSeconds: number;
  readonly coverageAvailable: boolean;
  readonly notes: string[];
  readonly statuses: MutantStatus[];
}

/** One mutant's outcome; `durationMs` is null when no test ran. */
interface MutantRun {
  readonly status: MutantStatus;
  readonly durationMs: number | null;
}

interface RunContext {
  readonly notes: string[];
  readonly binary: string;
  readonly runner: RunnerKind;
  readonly projectRoot: string;
  readonly timeoutMs: number;
  readonly coverage: CoverageIndex | null;
  readonly guard: WorkspaceGuard;
  readonly progress: ProgressReporter;
}

/**
 * Orchestrates `mutate`: plan mutants → acquire the workspace guard → plain
 * baseline (the exact mutant command, unmutated) → coverage baseline →
 * one test run per mutant → report.
 *
 * Mutants run one at a time, in report order, each written in place and
 * restored by the `WorkspaceGuard` — including on SIGINT/SIGTERM/SIGHUP.
 */
export class MutationPipeline {
  readonly analyzer: DirectoryAnalyzer;
  readonly planner: MutationPlanner;
  readonly commandRunner: CommandRunner;
  readonly testRunner: TestRunner;
  readonly hooks: ProcessHooks;
  readonly guardOptions: GuardOptions;

  constructor(
    deps: {
      analyzer?: DirectoryAnalyzer;
      planner?: MutationPlanner;
      commandRunner?: CommandRunner;
      testRunner?: TestRunner;
      hooks?: ProcessHooks;
      guardOptions?: GuardOptions;
    } = {}
  ) {
    this.analyzer = deps.analyzer ?? new DirectoryAnalyzer();
    this.planner = deps.planner ?? new MutationPlanner();
    this.commandRunner = deps.commandRunner ?? new CommandRunner();
    this.testRunner = deps.testRunner ?? new TestRunner();
    this.hooks = deps.hooks ?? nodeProcessHooks;
    this.guardOptions = deps.guardOptions ?? {};
  }

  async run(args: MutationRunArgs): Promise<MutationReport> {
    const progress = args.progress ?? ProgressReporter.silent;
    const sourcePath = path.resolve(args.sourcePath);
    const operators = args.operators ?? MUTATION_OPERATORS;

    progress.phase(`walking ${sourcePath}`);
    const plan = () => this.planFiles(sourcePath, args.options ?? defaultAnalysisOptions(), operators);
    const files = await plan();
    const planned = files.flatMap((f) => f.mutants);
    progress.phase(`generated ${planned.length} mutant(s) in ${files.length} file(s)`);

    if (args.dryRun || planned.every((p) => p.ignored)) {
      const statuses = planned.map((p): MutantStatus => (p.ignored ? "ignored" : "pending"));
      return buildReport({ sourcePath, operators, files, statuses, execution: null });
    }
    const execution = await this.execute(files, plan, sourcePath, args, progress);
    const report = buildReport({ sourcePath, operators, files: execution.files, statuses: execution.statuses, execution });
    const s = report.summary;
    progress.phase(
      `done — ${s.killed} killed, ${s.timedOut} timeout, ${s.survived} survived, ` +
        `${s.noCoverage} no_coverage, ${s.compileErrors} compile_error, ${s.ignored} ignored`
    );
    return report;
  }

  private async planFiles(
    sourcePath: string,
    options: AnalysisOptions,
    operators: readonly MutationOperator[]
  ): Promise<PlannedFile[]> {
    const refs = await this.analyzer.listFiles(sourcePath, options);
    return Promise.all(
      refs.map(async (ref) => {
        let bytes: Buffer;
        try {
          bytes = await readFile(ref.absolutePath);
        } catch (error) {
          throw SlopguardError.unreadableFile(ref.absolutePath, String(error));
        }
        const source = bytes.toString("utf8");
        return { ...ref, bytes, source, mutants: this.planner.plan(source, ref.relativePath, operators) };
      })
    );
  }

  private async execute(
    planned: PlannedFile[],
    plan: () => Promise<PlannedFile[]>,
    sourcePath: string,
    args: MutationRunArgs,
    progress: ProgressReporter
  ): Promise<Execution> {
    const projectRoot = args.projectDir ?? discoverProjectRoot(sourcePath);
    let runner = args.runner;
    if (runner === undefined) {
      progress.phase(`detecting test runner in ${projectRoot}`);
      runner = detectRunner(projectRoot);
    }
    const binary = runnerBinary(projectRoot, runner);
    const guard = WorkspaceGuard.acquire(projectRoot, this.guardOptions);
    const notes = [...guard.notes];
    const uninstall = this.installSignalHandlers(guard, progress);
    try {
      // Recovery may have restored a file the plan was read from: plan again.
      const files = notes.length > 0 ? await plan() : planned;
      progress.phase(`running baseline tests (${runner}) in ${projectRoot}`);
      const baseline = await this.commandRunner.run({
        binary,
        argv: mutantTestArguments(runner),
        cwd: projectRoot,
        timeoutMs: null,
        progress,
      });
      if (baseline.exitCode !== 0) {
        throw SlopguardError.baselineFailed(baseline.exitCode, baseline.outputTail.trim() || "no output captured");
      }
      const timeoutSeconds =
        args.timeoutSeconds ?? Math.ceil((baseline.durationMs / 1000) * 3) + TIMEOUT_GRACE_SECONDS;
      progress.phase(
        `baseline passed in ${(baseline.durationMs / 1000).toFixed(1)}s; timeout is ${timeoutSeconds}s per mutant`
      );
      const coverage = args.coverage === false ? null : await this.coverageBaseline(runner, projectRoot, notes, progress);
      const context = { notes, binary, runner, projectRoot, timeoutMs: timeoutSeconds * 1000, coverage, guard, progress };
      const statuses = await this.runMutants(files, context);
      return { files, projectRoot, runner, timeoutSeconds, coverageAvailable: coverage !== null, notes, statuses };
    } finally {
      uninstall();
      guard.release();
    }
  }

  /**
   * The coverage baseline only supplies line coverage — the plain baseline
   * already decided that the suite passes, so nothing here is fatal. A
   * non-zero exit (for example a coverage threshold in the project's config)
   * keeps the data it produced; a run with no usable data only costs the
   * `no_coverage` shortcut. Notes say which happened.
   */
  private async coverageBaseline(
    runner: RunnerKind,
    projectRoot: string,
    notes: string[],
    progress: ProgressReporter
  ): Promise<CoverageIndex | null> {
    const coverageDir = await mkdtemp(path.join(os.tmpdir(), "slopguard-"));
    try {
      let outcome: TestRunOutcome;
      try {
        outcome = await this.testRunner.runTests({ runner, projectRoot, coverageDir, progress });
      } catch (error) {
        // A known failure (no coverage produced, runner missing) costs only the shortcut.
        if (!(error instanceof SlopguardError)) throw error;
        notes.push(NOTE_NO_COVERAGE);
        return null;
      }
      const index =
        outcome.coverageJsonPath === null ? null : await loadCoverageIndex(outcome.coverageJsonPath).catch(() => null);
      if (index === null || index.fileCount === 0) {
        notes.push(NOTE_NO_COVERAGE);
        return null;
      }
      if (!outcome.testsPassed) notes.push(coverageExitNote(outcome.exitCode));
      return index;
    } finally {
      await rm(coverageDir, { recursive: true, force: true }); // slopguard-ignore-mutant(boolean_literal): mkdtemp created the directory, so force changes nothing
    }
  }

  private async runMutants(files: PlannedFile[], context: RunContext): Promise<MutantStatus[]> {
    const total = files.reduce((n, f) => n + f.mutants.length, 0);
    const statuses: MutantStatus[] = [];
    for (const file of files) {
      let changed = false;
      for (const mutant of file.mutants) {
        const result: MutantRun =
          changed && !mutant.ignored
            ? { status: "pending", durationMs: null }
            : await this.mutantStatus(file, mutant, context);
        // `pending` in a real run means the file changed under us: skip the rest of it.
        changed ||= result.status === "pending";
        const { status, durationMs } = result;
        statuses.push(status);
        const timing = durationMs === null ? "" : ` (${(durationMs / 1000).toFixed(1)}s)`;
        const index = String(statuses.length).padStart(String(total).length);
        const site = mutant.site;
        context.progress.phase(
          `[${index}/${total}] ${status.padEnd(13)} ${site.file}:${site.line}:${site.column} ${site.operator}${timing}`
        );
      }
    }
    return statuses;
  }

  private async mutantStatus(
    file: PlannedFile,
    mutant: PlannedMutant,
    context: RunContext
  ): Promise<MutantRun> {
    if (mutant.ignored) return { status: "ignored", durationMs: null };
    const line = mutant.site.line;
    if (context.coverage?.methodCoverage(file.absolutePath, line, line) === 0) {
      return { status: "no_coverage", durationMs: null };
    }
    const mutated = Buffer.from(applyMutant(file.source, mutant.site), "utf8");
    let outcome: CommandOutcome;
    try {
      outcome = await context.guard.withMutant(file.absolutePath, file.bytes, mutated, () =>
        this.commandRunner.run({
          binary: context.binary,
          argv: mutantTestArguments(context.runner),
          cwd: context.projectRoot,
          timeoutMs: context.timeoutMs,
          progress: context.progress,
        })
      );
    } catch (error) {
      if (!(error instanceof SourceChangedError)) throw error;
      context.notes.push(changedFileNote(file.absolutePath));
      return { status: "pending", durationMs: null };
    }
    return { status: classify(outcome, context.runner), durationMs: outcome.durationMs };
  }

  /**
   * Restore, release and exit on SIGINT/SIGTERM/SIGHUP. A failed restore is
   * printed even under `--quiet` and exits 1, because the source is left
   * mutated. Returns the uninstaller.
   */
  private installSignalHandlers(guard: WorkspaceGuard, progress: ProgressReporter): () => void {
    const installed: Array<[NodeJS.Signals, () => void]> = [];
    for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES) as Array<[NodeJS.Signals, number]>) {
      const handler = () => {
        this.commandRunner.killActive();
        let restored: string | null;
        try {
          restored = guard.restore();
          guard.release();
        } catch (error) {
          this.hooks.stderr(errorText(errorEnvelope(error)));
          this.hooks.exit(1);
          return;
        }
        progress.phase(restored === null ? "interrupted" : `interrupted — restored ${restored}`);
        this.hooks.exit(code);
      };
      this.hooks.on(signal, handler);
      installed.push([signal, handler]);
    }
    return () => {
      for (const [signal, handler] of installed) this.hooks.off(signal, handler);
    };
  }
}

export function changedFileNote(file: string): string {
  return `${file} changed while mutate was running, so its remaining mutants were not run.`;
}

export function coverageExitNote(exitCode: number): string {
  return `The coverage run exited with code ${exitCode}; its coverage data was still used.`;
}

export function classify(outcome: CommandOutcome, runner: RunnerKind): MutantStatus {
  if (outcome.timedOut) return "timeout";
  if (outcome.exitCode === 0) return "survived";
  // Only jest (through ts-jest) type-checks. vitest strips types, so a vitest
  // failure is always a test failure, even when test output quotes `error TS…`.
  const output = outcome.outputTail;
  if (runner === "jest" && output.includes(SUITE_FAILED) && TYPE_ERROR.test(output)) return "compile_error";
  return "killed";
}

function buildReport(args: {
  sourcePath: string;
  operators: readonly MutationOperator[];
  files: PlannedFile[];
  statuses: MutantStatus[];
  execution: Execution | null;
}): MutationReport {
  const planned = args.files.flatMap((f) => f.mutants);
  const mutants: MutantResult[] = planned.map((p, i) => ({
    id: mutantId(p.site),
    file: p.site.file,
    line: p.site.line,
    column: p.site.column,
    operator: p.site.operator,
    original: p.site.original,
    replacement: p.site.replacement,
    method: p.method,
    status: args.statuses[i]!,
  }));
  const summary = summarize(mutants, args.files.length);
  const execution = args.execution;
  return {
    schemaVersion: MUTATION_SCHEMA_VERSION,
    reportType: "mutation",
    tool: SlopguardVersion.toolName,
    toolVersion: SlopguardVersion.version,
    generatedAt: new Date().toISOString(),
    sourceRoot: args.sourcePath,
    projectRoot: execution?.projectRoot ?? null,
    runner: execution?.runner ?? null,
    timeoutSeconds: execution?.timeoutSeconds ?? null,
    coverageAvailable: execution?.coverageAvailable ?? false,
    operators: [...args.operators],
    notes: [...(execution?.notes ?? []), ...resultNotes(summary)],
    summary,
    mutants,
  };
}

function resultNotes(s: MutationReport["summary"]): string[] {
  const notes: string[] = [];
  if (s.survived > 0 && s.killed + s.timedOut === 0) notes.push(NOTE_ALL_SURVIVED);
  if (s.compileErrors > 0) {
    notes.push(`${s.compileErrors} mutant(s) did not compile and are excluded from the score.`);
  }
  return notes;
}
