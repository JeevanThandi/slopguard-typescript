import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProgressReporter } from "../src/core/progressReporter.js";
import { CommandRunner, mutantTestArguments } from "../src/mutation/commandRunner.js";
import type { SpawnFn } from "../src/coverage/testRunner.js";

/** A fake ChildProcess whose output, exit and errors are driven by hand. */
function fakeChild(pid: number | undefined = 4242) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number | undefined;
    kills: string[];
    kill: (signal: string) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.kills = [];
  child.kill = (signal: string) => {
    child.kills.push(signal);
  };
  return child;
}

const run = (runner: CommandRunner, timeoutMs: number | null = null, progress?: ProgressReporter) =>
  runner.run({ binary: "/bin/fake", argv: ["run"], cwd: "/tmp", timeoutMs, progress });

describe("mutantTestArguments", () => {
  it("disables coverage and stops at the first failure", () => {
    expect(mutantTestArguments("vitest")).toEqual(["run", "--bail=1", "--coverage.enabled=false", "--reporter=dot"]);
    expect(mutantTestArguments("jest")).toEqual(["--bail=1", "--coverage=false", "--watchAll=false", "--ci"]);
  });
});

describe("CommandRunner with a fake process", () => {
  it("spawns in a new process group with CI set, and reports exit code and output tail", async () => {
    const child = fakeChild();
    let options: Record<string, unknown> = {};
    const spawn: SpawnFn = (_cmd, _args, opts) => {
      options = opts as Record<string, unknown>;
      return child as never;
    };
    const raw: string[] = [];
    const progress = new ProgressReporter("verbose", () => {}, (chunk) => raw.push(String(chunk)));
    const pending = run(new CommandRunner(spawn, () => {}, "linux"), null, progress);
    child.stdout.emit("data", Buffer.from("out "));
    child.stderr.emit("data", Buffer.from("err"));
    child.emit("close", 1);
    const outcome = await pending;
    expect(outcome).toMatchObject({ exitCode: 1, timedOut: false, outputTail: "out err" });
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(raw.join("")).toBe("out err");
    expect(options.detached).toBe(true);
    expect((options.env as Record<string, string>).CI).toBe("1");
  });

  it("measures the duration with its clock", async () => {
    const child = fakeChild();
    const ticks = [1000, 1250];
    const runner = new CommandRunner(() => child as never, () => {}, "linux", () => ticks.shift()!);
    const pending = run(runner);
    child.emit("close", 0);
    expect((await pending).durationMs).toBe(250);
  });

  it("forgets a finished process and cancels its timer, so the next run survives it", async () => {
    const first = fakeChild(555);
    const second = fakeChild(556);
    const children = [first, second];
    const kills: number[] = [];
    const runner = new CommandRunner(() => children.shift() as never, (pid) => kills.push(pid), "linux");
    const pending = run(runner, 20);
    first.emit("close", 0);
    expect((await pending).timedOut).toBe(false);
    runner.killActive();
    const next = run(runner, null);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(kills).toEqual([]);
    second.emit("close", 0);
    expect((await next).timedOut).toBe(false);
  });

  it("forgets a process that failed to start", async () => {
    const child = fakeChild(556);
    const kills: number[] = [];
    const runner = new CommandRunner(() => child as never, (pid) => kills.push(pid), "linux");
    const pending = run(runner, 20);
    child.emit("error", new Error("EACCES"));
    await expect(pending).rejects.toMatchObject({ code: "runner_unavailable" });
    runner.killActive();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(kills).toEqual([]);
  });

  it("uses the default silent reporter and does not detach on Windows", async () => {
    const child = fakeChild();
    let detached: unknown;
    const spawn: SpawnFn = (_cmd, _args, opts) => {
      detached = opts.detached;
      return child as never;
    };
    const pending = run(new CommandRunner(spawn, () => {}, "win32"));
    child.emit("close", 0);
    expect((await pending).exitCode).toBe(0);
    expect(detached).toBe(false);
  });

  it("turns a spawn exception into runner_unavailable", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("ENOENT");
    };
    await expect(run(new CommandRunner(spawn))).rejects.toMatchObject({ code: "runner_unavailable" });
  });

  it("turns a spawn error event into runner_unavailable", async () => {
    const child = fakeChild();
    const pending = run(new CommandRunner(() => child as never, () => {}, "linux"), 60_000);
    child.emit("error", new Error("EACCES"));
    await expect(pending).rejects.toMatchObject({ code: "runner_unavailable" });
  });

  it("kills the whole process group when the timeout passes", async () => {
    const child = fakeChild(777);
    const kills: Array<[number, string]> = [];
    const runner = new CommandRunner(() => child as never, (pid, signal) => kills.push([pid, signal]), "darwin");
    const pending = run(runner, 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(kills).toEqual([[-777, "SIGKILL"]]);
    child.emit("close", null);
    expect(await pending).toMatchObject({ exitCode: null, timedOut: true });
  });

  it("kills the child directly on Windows", async () => {
    const child = fakeChild();
    const runner = new CommandRunner(() => child as never, () => {}, "win32");
    const pending = run(runner, 60_000);
    runner.killActive();
    expect(child.kills).toEqual(["SIGKILL"]);
    child.emit("close", null);
    await pending;
  });

  it("ignores kill errors, idle runners and children without a pid", async () => {
    const idle = new CommandRunner(() => fakeChild() as never);
    expect(() => idle.killActive()).not.toThrow();

    const child = fakeChild();
    const throwing = new CommandRunner(
      () => child as never,
      () => {
        throw new Error("ESRCH");
      },
      "linux"
    );
    const pending = run(throwing, 60_000);
    expect(() => throwing.killActive()).not.toThrow();
    child.emit("close", 0);
    await pending;

    const pidless = fakeChild(undefined);
    const noPid = new CommandRunner(() => pidless as never, () => {
      throw new Error("must not be called");
    }, "linux");
    const pendingNoPid = run(noPid, 60_000);
    expect(() => noPid.killActive()).not.toThrow();
    pidless.emit("close", 0);
    await pendingNoPid;
  });
});

describe.skipIf(process.platform === "win32")("CommandRunner with a real process group", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "slopguard-cmd-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("kills the runner and the worker it forked on timeout", async () => {
    const pidFile = path.join(dir, "grandchild.pid");
    // The child forks a long-lived grandchild, records its pid, then hangs.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const runner = new CommandRunner();
    const started = Date.now();
    const outcome = await runner.run({
      binary: process.execPath,
      argv: ["-e", script],
      cwd: dir,
      timeoutMs: 4000,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(15_000);

    const grandchild = Number(await readFile(pidFile, "utf8"));
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(grandchild, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 30_000);
});
