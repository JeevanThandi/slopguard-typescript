import { spawn as nodeSpawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SlopguardError } from "../core/errors.js";
import { ProgressReporter } from "../core/progressReporter.js";
import { coverageArguments, runnerBinary, RunnerKind } from "./runnerDetection.js";

/** The slice of `child_process.spawn` this runner uses. Injectable for tests. */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface TestRunOutcome {
  /** Path of the produced `coverage-final.json`, or null if the run finished without producing one. */
  coverageJsonPath: string | null;
  /** Whether the test suite itself passed. Test failures don't abort — partial coverage is still useful. */
  testsPassed: boolean;
}

/**
 * Drives the project's own test runner to *produce* an istanbul
 * `coverage-final.json` — the analog of `XcodebuildRunner` driving
 * `xcodebuild test -enableCodeCoverage YES`.
 *
 * Coverage is not a user input to slopguard; it's an artifact slopguard
 * generates as part of its own investigation. This runner owns that step:
 * locate the project-local runner binary, invoke it with flags that force a
 * json coverage report into a slopguard-owned directory, and hand the json
 * path back for `CoverageIndex` to read.
 */
export class TestRunner {
  private readonly spawn: SpawnFn;

  constructor(spawn: SpawnFn = nodeSpawn) {
    this.spawn = spawn;
  }

  /**
   * Run the suite and return where coverage landed.
   *
   * A non-zero exit with `coverage-final.json` present means tests failed but
   * coverage was still emitted — keep going. A non-zero exit with no json
   * means the run itself broke (config error, missing coverage provider,
   * compile failure) — abort with the stderr tail so the user can see why.
   */
  async runTests(args: {
    runner: RunnerKind;
    projectRoot: string;
    coverageDir: string;
    progress?: ProgressReporter;
  }): Promise<TestRunOutcome> {
    const progress = args.progress ?? ProgressReporter.silent;
    const binary = runnerBinary(args.projectRoot, args.runner);
    const argv = coverageArguments(args.runner, args.coverageDir);

    progress.phase(
      `running ${args.runner} with coverage in ${args.projectRoot} — this can take a while`
    );
    const { exitCode, outputTail } = await this.spawnRunner(binary, argv, args.projectRoot, progress);

    const coverageJsonPath = path.join(args.coverageDir, "coverage-final.json");
    const produced = fs.existsSync(coverageJsonPath);

    if (exitCode === 0) {
      return { coverageJsonPath: produced ? coverageJsonPath : null, testsPassed: true };
    }
    if (produced) {
      return { coverageJsonPath, testsPassed: false };
    }
    throw SlopguardError.testRunFailed(exitCode, outputTail.trim() || "no output captured");
  }

  private spawnRunner(
    binary: string,
    argv: string[],
    cwd: string,
    progress: ProgressReporter
  ): Promise<{ exitCode: number; outputTail: string }> {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(binary, argv, {
          cwd,
          // CI=1 keeps runners out of watch/interactive modes even when their
          // config asks for them; no color keeps the captured tail readable.
          env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(SlopguardError.runnerUnavailable(`could not launch ${binary}: ${String(error)}`));
        return;
      }

      // Drain stdout/stderr — discard by default, stream through under
      // --verbose. Either way the pipes must be drained or the subprocess
      // blocks once its kernel buffer fills. Keep a bounded tail for error
      // reporting.
      const tail: Buffer[] = [];
      let tailBytes = 0;
      const TAIL_LIMIT = 8 * 1024;
      const onChunk = (chunk: Buffer) => {
        progress.raw(chunk);
        tail.push(chunk);
        tailBytes += chunk.length;
        while (tail.length > 1 && tailBytes > TAIL_LIMIT) {
          tailBytes -= tail.shift()!.length;
        }
      };
      child.stdout!.on("data", onChunk);
      child.stderr!.on("data", onChunk);

      child.on("error", (error) => {
        reject(SlopguardError.runnerUnavailable(`could not launch ${binary}: ${String(error)}`));
      });
      child.on("close", (code) => {
        resolve({ exitCode: code ?? 1, outputTail: Buffer.concat(tail).toString("utf8") });
      });
    });
  }
}
