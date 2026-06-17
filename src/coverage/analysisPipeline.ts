import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CoverageProvider } from "../core/aggregation/coverageProvider.js";
import { CrapAggregator } from "../core/aggregation/crapAggregator.js";
import {
  AnalysisOptions,
  defaultAnalysisOptions,
  DirectoryAnalyzer,
} from "../core/analysis/directoryAnalyzer.js";
import { DEFAULT_CRAP_THRESHOLD } from "../core/crap.js";
import { SlopguardError } from "../core/errors.js";
import { CrapReport } from "../core/models.js";
import { ProgressReporter } from "../core/progressReporter.js";
import { CoverageIndex } from "./coverageIndex.js";
import { parseIstanbulJson } from "./istanbul.js";
import { discoverProjectRoot } from "./projectRootDiscovery.js";
import { detectRunner, RunnerKind } from "./runnerDetection.js";
import { TestRunner } from "./testRunner.js";

/**
 * How the pipeline gets its coverage signal.
 *
 * `auto` is the default and the main mode the CLI exposes — slopguard runs
 * the project's test suite itself. `prebuilt` ingests an existing istanbul
 * `coverage-final.json` (useful when CI already produced one, or for runners
 * slopguard can't drive directly — point nyc/c8/mocha output here). `none`
 * short-circuits coverage entirely and reports every method at 0%.
 */
export type CoverageSource =
  | {
      mode: "auto";
      /** Explicit runner; auto-detected from the project when omitted. */
      runner?: RunnerKind;
      /** Working directory for the test runner; discovered from the analyzed source path when omitted. */
      projectDir?: string;
    }
  | { mode: "prebuilt"; coverageFile: string }
  | { mode: "none" };

/** Resolve a `CoverageSource` from CLI-style flag values. Pure — unit-testable without the CLI. */
export function coverageSourceFromFlags(flags: {
  noCoverage: boolean;
  coverageFile?: string;
  runner?: RunnerKind;
  projectDir?: string;
  cwd?: string;
}): CoverageSource {
  const cwd = flags.cwd ?? process.cwd();
  if (flags.noCoverage) return { mode: "none" };
  if (flags.coverageFile) {
    return { mode: "prebuilt", coverageFile: path.resolve(cwd, expandTilde(flags.coverageFile)) };
  }
  return {
    mode: "auto",
    runner: flags.runner,
    // Pass undefined through when the caller didn't supply --project-dir;
    // the pipeline will discover the right project root from the source path.
    projectDir: flags.projectDir ? path.resolve(cwd, expandTilde(flags.projectDir)) : undefined,
  };
}

export function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Orchestrates the full analyze → coverage-join → CRAP-report pipeline.
 *
 * Coverage is treated as an *internal artifact*: in `auto` mode the pipeline
 * drives the project's test runner itself, ingests the resulting
 * `coverage-final.json`, and cleans up. Callers don't pass coverage in.
 */
export class AnalysisPipeline {
  readonly analyzer: DirectoryAnalyzer;
  readonly testRunner: TestRunner;
  readonly aggregator: CrapAggregator;

  constructor(
    analyzer: DirectoryAnalyzer = new DirectoryAnalyzer(),
    testRunner: TestRunner = new TestRunner(),
    aggregator: CrapAggregator = new CrapAggregator()
  ) {
    this.analyzer = analyzer;
    this.testRunner = testRunner;
    this.aggregator = aggregator;
  }

  /** Run the full pipeline against a directory or single source file. */
  async run(args: {
    sourcePath: string;
    coverage?: CoverageSource;
    threshold?: number;
    options?: AnalysisOptions;
    progress?: ProgressReporter;
  }): Promise<CrapReport> {
    const progress = args.progress ?? ProgressReporter.silent;
    const sourcePath = path.resolve(args.sourcePath);
    const options = args.options ?? defaultAnalysisOptions();
    const coverage = args.coverage ?? { mode: "auto" as const };

    progress.phase(`walking ${sourcePath}`);
    const fileReports = await this.analyzer.analyze(sourcePath, options);
    const methodCount = fileReports.reduce((n, f) => n + f.methods.length, 0);
    progress.phase(`parsed ${fileReports.length} source file(s), ${methodCount} method(s)`);

    const resolved = await this.resolveCoverage(coverage, sourcePath, progress);
    try {
      let provider: CoverageProvider | null = null;
      let coverageDataPath: string | null = null;
      const notes: string[] = [...resolved.notes];

      if (resolved.coverageJsonPath !== null) {
        progress.phase("parsing coverage data");
        const index = await loadCoverageIndex(resolved.coverageJsonPath);
        if (index.fileCount === 0) {
          // The runner ran and wrote a report, but nothing was instrumented.
          // Reporting 0% silently would misrepresent it — surface why.
          notes.push(
            "The test run produced no per-file coverage data — " +
              "check the runner's coverage include patterns. All methods are being reported at 0%."
          );
        } else {
          provider = index;
          // Ephemeral coverage dirs (auto mode) are deleted in cleanup — don't
          // surface a path that won't exist by the time the user reads the report.
          coverageDataPath = resolved.isEphemeral ? null : path.resolve(resolved.coverageJsonPath);
        }
      }

      return this.aggregator.aggregate({
        fileReports,
        sourceRoot: sourcePath,
        coverageDataPath,
        threshold: args.threshold ?? DEFAULT_CRAP_THRESHOLD,
        coverage: provider,
        notes,
      });
    } finally {
      await resolved.cleanup();
    }
  }

  /**
   * Materialize the user's choice of `CoverageSource` into a concrete
   * `coverage-final.json` on disk (or null for `none`), plus any diagnostic
   * notes gathered along the way and a cleanup hook for temp dirs we own.
   */
  private async resolveCoverage(
    source: CoverageSource,
    sourcePath: string,
    progress: ProgressReporter
  ): Promise<ResolvedCoverage> {
    switch (source.mode) {
      case "none":
        return { coverageJsonPath: null, isEphemeral: false, notes: [], cleanup: async () => {} };

      case "prebuilt":
        return {
          coverageJsonPath: source.coverageFile,
          isEphemeral: false,
          notes: [],
          cleanup: async () => {},
        };

      case "auto": {
        const projectRoot = source.projectDir ?? discoverProjectRoot(sourcePath);
        let runner: RunnerKind;
        if (source.runner) {
          runner = source.runner;
        } else {
          progress.phase(`detecting test runner in ${projectRoot}`);
          runner = detectRunner(projectRoot);
        }
        const tempDir = await mkdtemp(path.join(os.tmpdir(), "slopguard-"));
        const cleanup = async () => {
          await rm(tempDir, { recursive: true, force: true });
        };
        let outcome;
        try {
          outcome = await this.testRunner.runTests({
            runner,
            projectRoot,
            coverageDir: tempDir,
            progress,
          });
        } catch (error) {
          await cleanup();
          throw error;
        }
        const notes: string[] = [];
        if (!outcome.testsPassed) {
          notes.push(
            "Some tests failed during the coverage run — coverage reflects the failing run."
          );
        }
        if (outcome.coverageJsonPath === null) {
          // The runner exited cleanly but produced no json. The most common
          // cause is a suite with zero matching test files; either way the
          // analysis is still useful, the user just needs to know why
          // coverage is zero.
          notes.push(
            "The test run completed but no coverage data was produced — " +
              "either no tests matched or coverage tooling is missing. " +
              "All methods are being reported at 0%."
          );
        }
        return { coverageJsonPath: outcome.coverageJsonPath, isEphemeral: true, notes, cleanup };
      }
    }
  }
}

interface ResolvedCoverage {
  coverageJsonPath: string | null;
  isEphemeral: boolean;
  notes: string[];
  cleanup: () => Promise<void>;
}

async function loadCoverageIndex(coverageJsonPath: string): Promise<CoverageIndex> {
  let text: string;
  try {
    text = await readFile(coverageJsonPath, "utf8");
  } catch (error) {
    throw SlopguardError.unreadableFile(coverageJsonPath, String(error));
  }
  try {
    return new CoverageIndex(parseIstanbulJson(text));
  } catch (error) {
    throw SlopguardError.coverageDecodeFailed(String(error));
  }
}
