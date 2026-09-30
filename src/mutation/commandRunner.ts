import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { SlopguardError } from "../core/errors.js";
import { ProgressReporter } from "../core/progressReporter.js";
import { OutputTail } from "../coverage/outputTail.js";
import type { RunnerKind } from "../coverage/runnerDetection.js";
import type { SpawnFn } from "../coverage/testRunner.js";

/** How one test-runner invocation ended. */
export interface CommandOutcome {
  /** The exit code, or null when a signal ended the process (the timeout kill). */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Bounded tail of the combined stdout/stderr. */
  readonly outputTail: string;
}

/** Sends a signal to a process or, with a negative pid, a process group. */
export type KillFn = (pid: number, signal: NodeJS.Signals) => void;

/**
 * Arguments for one mutant run: no coverage (a project config that enables it
 * could fail thresholds and fake a kill), stop at the first failing test, and
 * keep the output small.
 */
export function mutantTestArguments(runner: RunnerKind): string[] {
  switch (runner) {
    case "vitest":
      return ["run", "--bail=1", "--coverage.enabled=false", "--reporter=dot"];
    case "jest":
      return ["--bail=1", "--coverage=false", "--watchAll=false", "--ci"];
  }
}

/**
 * Runs the project's test runner for `mutate` — the baseline and one run per
 * mutant. Each run gets its own process group, so a timeout kills the runner
 * and every worker it forked: an infinite-loop mutant must not leave a
 * spinning test process behind.
 */
export class CommandRunner {
  private readonly spawn: SpawnFn;
  private readonly kill: KillFn;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private active: ChildProcess | null = null;

  constructor(
    spawn: SpawnFn = nodeSpawn,
    kill: KillFn = (pid, signal) => process.kill(pid, signal),
    platform: NodeJS.Platform = process.platform,
    now: () => number = () => performance.now()
  ) {
    this.spawn = spawn;
    this.kill = kill;
    this.platform = platform;
    this.now = now;
  }

  /** Run to completion, or until `timeoutMs` passes (null = no limit). */
  run(args: {
    binary: string;
    argv: string[];
    cwd: string;
    timeoutMs: number | null;
    progress?: ProgressReporter;
  }): Promise<CommandOutcome> {
    const progress = args.progress ?? ProgressReporter.silent;
    const started = this.now();
    return new Promise((resolve, reject) => {
      const launchError = (error: unknown) =>
        SlopguardError.runnerUnavailable(`could not launch ${args.binary}: ${String(error)}`);
      let child: ChildProcess;
      try {
        child = this.spawn(args.binary, args.argv, {
          cwd: args.cwd,
          // CI=1 keeps runners out of watch mode and stops snapshot writes.
          env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
          stdio: ["ignore", "pipe", "pipe"],
          // A new process group (POSIX), so killActive() can reach every worker.
          detached: this.platform !== "win32",
        });
      } catch (error) {
        reject(launchError(error));
        return;
      }
      this.active = child;
      const tail = new OutputTail();
      const onChunk = (chunk: Buffer) => {
        progress.raw(chunk);
        tail.push(chunk);
      };
      child.stdout!.on("data", onChunk);
      child.stderr!.on("data", onChunk);

      let timedOut = false;
      const timer =
        args.timeoutMs === null
          ? null
          : setTimeout(() => {
              timedOut = true;
              this.killActive();
            }, args.timeoutMs);
      const finish = () => {
        if (timer !== null) clearTimeout(timer);
        this.active = null;
      };
      child.on("error", (error) => {
        finish();
        reject(launchError(error));
      });
      child.on("close", (code) => {
        finish();
        resolve({ exitCode: code, timedOut, durationMs: this.now() - started, outputTail: tail.text() });
      });
    });
  }

  /** Kill the running command and its workers, if any. Safe to call at any time. */
  killActive(): void {
    const child = this.active;
    if (child === null || child.pid === undefined) return;
    try {
      if (this.platform === "win32") {
        child.kill("SIGKILL");
      } else {
        this.kill(-child.pid, "SIGKILL");
      }
    } catch {
      // The process already exited.
    }
  }
}
