import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestRunner, type SpawnFn } from "../src/coverage/testRunner.js";

// runnerBinary() requires node_modules/.bin/<runner> to exist, so point
// projectRoot at this repo (which has vitest installed) while keeping the
// temp dir as the coverage output dir.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A fake ChildProcess whose stdout/stderr/close/error can be driven by hand. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "slopguard-runner-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeCoverage() {
  await writeFile(path.join(root, "coverage-final.json"), "{}");
}

describe("TestRunner.runTests", () => {
  it("returns the coverage path and testsPassed=true on a clean exit", async () => {
    await writeCoverage();
    const child = fakeChild();
    const spawn: SpawnFn = () => child as never;
    const runner = new TestRunner(spawn);
    const p = runner.runTests({ runner: "vitest", projectRoot: repoRoot, coverageDir: root });
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("ok\n"));
      child.emit("close", 0);
    });
    const outcome = await p;
    expect(outcome.testsPassed).toBe(true);
    expect(outcome.coverageJsonPath).toBe(path.join(root, "coverage-final.json"));
  });

  it("reports null coverage path when a clean run produced no json", async () => {
    const child = fakeChild();
    const runner = new TestRunner((() => child) as never);
    const p = runner.runTests({ runner: "vitest", projectRoot: repoRoot, coverageDir: root });
    queueMicrotask(() => child.emit("close", 0));
    const outcome = await p;
    expect(outcome.testsPassed).toBe(true);
    expect(outcome.coverageJsonPath).toBeNull();
  });

  it("keeps coverage but marks testsPassed=false on a non-zero exit with json", async () => {
    await writeCoverage();
    const child = fakeChild();
    const runner = new TestRunner((() => child) as never);
    const p = runner.runTests({ runner: "vitest", projectRoot: repoRoot, coverageDir: root });
    queueMicrotask(() => child.emit("close", 1));
    const outcome = await p;
    expect(outcome.testsPassed).toBe(false);
    expect(outcome.coverageJsonPath).toBe(path.join(root, "coverage-final.json"));
  });

  it("throws test_run_failed when a non-zero exit produced no json", async () => {
    const child = fakeChild();
    const runner = new TestRunner((() => child) as never);
    const p = runner.runTests({ runner: "vitest", projectRoot: repoRoot, coverageDir: root });
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("config error\n"));
      child.emit("close", 7);
    });
    await expect(p).rejects.toMatchObject({ code: "test_run_failed" });
  });

  it("falls back to a placeholder tail when a failing run emitted nothing", async () => {
    const child = fakeChild();
    const runner = new TestRunner((() => child) as never);
    const p = runner.runTests({ runner: "vitest", projectRoot: repoRoot, coverageDir: root });
    queueMicrotask(() => child.emit("close", 2));
    await expect(p).rejects.toThrow(/no output captured/);
  });

  it("bounds the retained output tail under a flood of chunks", async () => {
    const child = fakeChild();
    const runner = new TestRunner((() => child) as never);
    const p = runner.runTests({ runner: "vitest", projectRoot: repoRoot, coverageDir: root });
    queueMicrotask(() => {
      // > 8 KiB across many chunks forces the tail-trimming shift loop.
      for (let i = 0; i < 200; i++) child.stdout.emit("data", Buffer.alloc(100, 97));
      child.emit("close", 1);
    });
    await expect(p).rejects.toMatchObject({ code: "test_run_failed" });
  });

  it("treats a null close code as a failure exit", async () => {
    const child = fakeChild();
    const runner = new TestRunner((() => child) as never);
    const p = runner.runTests({ runner: "vitest", projectRoot: repoRoot, coverageDir: root });
    queueMicrotask(() => child.emit("close", null)); // code ?? 1 → 1, no json → throws
    await expect(p).rejects.toMatchObject({ code: "test_run_failed" });
  });

  it("maps a synchronous spawn throw to runner_unavailable", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("ENOENT");
    };
    const runner = new TestRunner(spawn);
    await expect(
      runner.runTests({ runner: "vitest", projectRoot: repoRoot, coverageDir: root })
    ).rejects.toMatchObject({ code: "runner_unavailable" });
  });

  it("maps an async child 'error' event to runner_unavailable", async () => {
    const child = fakeChild();
    const runner = new TestRunner((() => child) as never);
    const p = runner.runTests({ runner: "vitest", projectRoot: repoRoot, coverageDir: root });
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
    await expect(p).rejects.toMatchObject({ code: "runner_unavailable" });
  });
});
