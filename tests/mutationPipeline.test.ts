import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlopguardError } from "../src/core/errors.js";
import { ProgressReporter } from "../src/core/progressReporter.js";
import type { TestRunner, TestRunOutcome } from "../src/coverage/testRunner.js";
import { CommandOutcome, CommandRunner } from "../src/mutation/commandRunner.js";
import {
  changedFileNote,
  classify,
  coverageExitNote,
  MutationPipeline,
  NOTE_ALL_SURVIVED,
  NOTE_NO_COVERAGE,
  ProcessHooks,
} from "../src/mutation/mutationPipeline.js";
import { guardDirectory, WorkspaceGuard } from "../src/mutation/workspaceGuard.js";
import { MutationPlanner } from "../src/core/mutation/mutationPlanner.js";

const CALC = [
  "export function calc(a: number, b: number): number {",
  "  if (a > b) {",
  "    return a - b;",
  "  }",
  "  return a + b;",
  "}",
  "",
].join("\n");

/** Line 3 never runs; lines 2 and 5 do. */
function coverageJson(file: string) {
  const range = (line: number) => ({ start: { line, column: 0 }, end: { line, column: 10 } });
  return JSON.stringify({
    [file]: {
      path: file,
      statementMap: { "0": range(2), "1": range(3), "2": range(5) },
      fnMap: {},
      branchMap: {},
      s: { "0": 4, "1": 0, "2": 4 },
      f: {},
      b: {},
    },
  });
}

const outcome = (overrides: Partial<CommandOutcome> = {}): CommandOutcome => ({
  exitCode: 1,
  timedOut: false,
  durationMs: 100,
  outputTail: "",
  ...overrides,
});

/** Replays canned outcomes and records what the source file held during each run. */
class FakeCommandRunner extends CommandRunner {
  readonly calls: Array<{ argv: string[]; timeoutMs: number | null; content: string }> = [];
  killed = 0;
  onRun: (call: number) => void = () => {};

  constructor(
    private readonly outcomes: CommandOutcome[],
    private readonly watched: string
  ) {
    super();
  }

  override async run(args: { argv: string[]; timeoutMs: number | null }): Promise<CommandOutcome> {
    this.calls.push({ argv: args.argv, timeoutMs: args.timeoutMs, content: fs.readFileSync(this.watched, "utf8") });
    this.onRun(this.calls.length);
    return this.outcomes.shift()!;
  }

  override killActive(): void {
    this.killed += 1;
  }
}

type FakeTestRunner = TestRunner & { runs: number; coverageDirs: string[] };

function fakeTestRunner(result: TestRunOutcome | Error): FakeTestRunner {
  const runner = {
    runs: 0,
    coverageDirs: [] as string[],
    runTests: async (args: { coverageDir: string }) => {
      runner.runs += 1;
      runner.coverageDirs.push(args.coverageDir);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return runner as unknown as FakeTestRunner;
}

let root: string;
let project: string;
let source: string;
let tmpRoot: string;
let covFile: string;
let lines: string[];
let progress: ProgressReporter;
let signals: Map<string, () => void>;
let removed: string[];
let exits: number[];
let guardAtExit: boolean[];
let errors: string[];
let hooks: ProcessHooks;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "slopguard-mp-"));
  project = path.join(root, "project");
  tmpRoot = path.join(root, "tmp");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, "node_modules", ".bin"), { recursive: true });
  fs.mkdirSync(tmpRoot);
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ devDependencies: { vitest: "*" } }));
  fs.writeFileSync(path.join(project, "node_modules", ".bin", "vitest"), "");
  fs.writeFileSync(path.join(project, "node_modules", ".bin", "jest"), "");
  source = path.join(project, "src", "calc.ts");
  fs.writeFileSync(source, CALC);
  covFile = path.join(root, "coverage-final.json");
  fs.writeFileSync(covFile, coverageJson(source));
  lines = [];
  progress = new ProgressReporter("normal", (line) => lines.push(line), () => {});
  signals = new Map();
  removed = [];
  exits = [];
  guardAtExit = [];
  errors = [];
  hooks = {
    on: (signal, handler) => signals.set(signal, handler),
    off: (signal) => removed.push(signal),
    exit: (code) => {
      exits.push(code);
      // A real exit never reaches the pipeline's `finally`: record what it left.
      guardAtExit.push(fs.existsSync(guardDirectory(project, tmpRoot)));
      throw new Error(`exit ${code}`);
    },
    stderr: (line) => errors.push(line),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const passedCoverage: TestRunOutcome = { coverageJsonPath: "", testsPassed: true, exitCode: 0, outputTail: "" };

function pipeline(commandRunner: CommandRunner, testRunner: TestRunner = fakeTestRunner({ ...passedCoverage, coverageJsonPath: covFile })) {
  return new MutationPipeline({ commandRunner, testRunner, hooks, guardOptions: { tmpRoot } });
}

describe("MutationPipeline", () => {
  it("runs a baseline, skips uncovered lines, classifies every mutant and restores the source", async () => {
    const runner = new FakeCommandRunner(
      [
        outcome({ exitCode: 0, durationMs: 2000 }),
        outcome({ exitCode: 1 }),
        outcome({ exitCode: 0 }),
        outcome({ exitCode: null, timedOut: true }),
      ],
      source
    );
    const coverage = fakeTestRunner({ ...passedCoverage, coverageJsonPath: covFile });
    const plan = vi.spyOn(MutationPlanner.prototype, "plan");
    const report = await pipeline(runner, coverage).run({ sourcePath: path.join(project, "src"), progress });

    expect(plan).toHaveBeenCalledTimes(1);
    expect(coverage.coverageDirs).toHaveLength(1);
    expect(fs.existsSync(coverage.coverageDirs[0]!)).toBe(false);
    expect(report.mutants.map((m) => `${m.id} ${m.status} ${m.method}`)).toEqual([
      "calc.ts:2:9:boundary killed calc",
      "calc.ts:2:9:negate_conditional survived calc",
      "calc.ts:3:14:arithmetic no_coverage calc",
      "calc.ts:5:12:arithmetic timeout calc",
    ]);
    expect(report).toMatchObject({
      schemaVersion: "1",
      reportType: "mutation",
      tool: "slopguard-typescript",
      sourceRoot: path.join(project, "src"),
      projectRoot: project,
      runner: "vitest",
      timeoutSeconds: 16,
      coverageAvailable: true,
      notes: [],
    });
    expect(report.summary).toMatchObject({ killed: 1, survived: 1, noCoverage: 1, timedOut: 1, mutationScore: 50 });
    expect(report.generatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

    expect(runner.calls.map((c) => c.timeoutMs)).toEqual([null, 16_000, 16_000, 16_000]);
    expect(runner.calls[0]!.content).toBe(CALC);
    expect(runner.calls[1]!.content).toContain("if (a >= b)");
    expect(runner.calls[2]!.content).toContain("if (a <= b)");
    expect(runner.calls[3]!.content).toContain("return a - b;\n  }\n  return a - b;");
    expect(fs.readFileSync(source, "utf8")).toBe(CALC);
    expect(fs.existsSync(guardDirectory(project, tmpRoot))).toBe(false);
    expect(removed.sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);

    expect(lines).toContain(`slopguard: walking ${path.join(project, "src")}`);
    expect(lines).toContain("slopguard: generated 4 mutant(s) in 1 file(s)");
    expect(lines).toContain(`slopguard: running baseline tests (vitest) in ${project}`);
    expect(lines).toContain("slopguard: detecting test runner in " + project);
    expect(lines).toContain("slopguard: baseline passed in 2.0s; timeout is 16s per mutant");
    expect(lines).toContain("slopguard: [1/4] killed        calc.ts:2:9 boundary (0.1s)");
    expect(lines).toContain("slopguard: [3/4] no_coverage   calc.ts:3:14 arithmetic");
    expect(lines.at(-1)).toBe(
      "slopguard: done — 1 killed, 1 timeout, 1 survived, 1 no_coverage, 0 compile_error, 0 ignored"
    );
  });

  it("lists mutants without running anything in a dry run", async () => {
    fs.writeFileSync(source, CALC.replace("return a - b;", "return a - b; // slopguard-ignore-mutant"));
    const runner = new FakeCommandRunner([], source);
    const report = await pipeline(runner).run({ sourcePath: source, dryRun: true, operators: ["arithmetic"] });
    expect(report.mutants.map((m) => m.status)).toEqual(["ignored", "pending"]);
    expect(report).toMatchObject({ runner: null, projectRoot: null, timeoutSeconds: null, coverageAvailable: false });
    expect(report.operators).toEqual(["arithmetic"]);
    expect(runner.calls).toHaveLength(0);
  });

  it("skips the baseline when every mutant is ignored", async () => {
    fs.writeFileSync(source, "export const n = 1 + 2; // slopguard-ignore-mutant\n");
    const runner = new FakeCommandRunner([], source);
    const report = await pipeline(runner).run({ sourcePath: source });
    expect(report.summary).toMatchObject({ mutantCount: 1, ignored: 1, mutationScore: null });
    expect(report.runner).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  it("stops with baseline_failed when the unmutated suite fails, touching nothing", async () => {
    const runner = new FakeCommandRunner([outcome({ exitCode: 3, outputTail: "  1 failed  " })], source);
    await expect(pipeline(runner).run({ sourcePath: source, runner: "vitest" })).rejects.toMatchObject({
      code: "baseline_failed",
      message: expect.stringContaining("(exit 3). Fix the failing tests first: 1 failed"),
    });
    const silent = new FakeCommandRunner([outcome({ exitCode: null })], source);
    await expect(pipeline(silent).run({ sourcePath: source })).rejects.toThrow("no output captured");
    expect(fs.readFileSync(source, "utf8")).toBe(CALC);
    expect(fs.existsSync(guardDirectory(project, tmpRoot))).toBe(false);
  });

  it("tests every mutant with --no-coverage and honours an explicit timeout", async () => {
    const runner = new FakeCommandRunner(
      [outcome({ exitCode: 0 }), ...Array.from({ length: 4 }, () => outcome({ exitCode: 1 }))],
      source
    );
    const testRunner = fakeTestRunner(passedCoverage);
    const report = await pipeline(runner, testRunner).run({ sourcePath: source, coverage: false, timeoutSeconds: 2.5 });
    expect(testRunner.runs).toBe(0);
    expect(report).toMatchObject({ coverageAvailable: false, timeoutSeconds: 2.5 });
    expect(report.summary).toMatchObject({ killed: 4, mutationScore: 100 });
    expect(runner.calls.slice(1).map((c) => c.timeoutMs)).toEqual([2500, 2500, 2500, 2500]);
  });

  it("keeps coverage from a coverage run that exits non-zero, with a note", async () => {
    const runner = new FakeCommandRunner([outcome({ exitCode: 0 }), outcome(), outcome(), outcome()], source);
    const coverage = fakeTestRunner({ coverageJsonPath: covFile, testsPassed: false, exitCode: 1, outputTail: "" });
    const report = await pipeline(runner, coverage).run({ sourcePath: source });
    expect(report.notes).toEqual([coverageExitNote(1)]);
    expect(report.summary.noCoverage).toBe(1);
  });

  it("tests every mutant, with a note, when the coverage run yields no usable data", async () => {
    const empty = path.join(root, "empty.json");
    fs.writeFileSync(empty, "{}");
    const torn = path.join(root, "torn.json");
    fs.writeFileSync(torn, "{ not json");
    const cases: Array<TestRunOutcome | Error> = [
      SlopguardError.testRunFailed(1, "no coverage provider"),
      SlopguardError.runnerUnavailable("gone"),
      { ...passedCoverage, coverageJsonPath: null },
      { ...passedCoverage, coverageJsonPath: null, testsPassed: false, exitCode: 1 },
      { ...passedCoverage, coverageJsonPath: empty },
      { ...passedCoverage, coverageJsonPath: torn },
    ];
    for (const result of cases) {
      const runner = new FakeCommandRunner([outcome({ exitCode: 0 }), ...Array.from({ length: 4 }, () => outcome())], source);
      const report = await pipeline(runner, fakeTestRunner(result)).run({ sourcePath: source });
      expect(report.notes).toEqual([NOTE_NO_COVERAGE]);
      expect(report.coverageAvailable).toBe(false);
      expect(report.summary.killed).toBe(4);
    }
  });

  it("propagates an unexpected coverage-run error after releasing", async () => {
    await expect(
      pipeline(new FakeCommandRunner([outcome({ exitCode: 0 })], source), fakeTestRunner(new Error("plain"))).run({
        sourcePath: source,
      })
    ).rejects.toThrow("plain");
    expect(fs.existsSync(guardDirectory(project, tmpRoot))).toBe(false);
  });

  it("stops mutating a file that someone edits during the run, and keeps the edit", async () => {
    const edited = CALC.replace("return a + b;", "return b + a; // edited");
    const watching = new ProgressReporter(
      "normal",
      (line) => {
        lines.push(line);
        if (line.startsWith("slopguard: [1/4]")) fs.writeFileSync(source, edited);
      },
      () => {}
    );
    const runner = new FakeCommandRunner([outcome({ exitCode: 0 }), outcome()], source);
    const report = await pipeline(runner).run({ sourcePath: source, coverage: false, progress: watching });
    expect(report.mutants.map((m) => m.status)).toEqual(["killed", "pending", "pending", "pending"]);
    expect(report.notes).toEqual([changedFileNote(source)]);
    expect(runner.calls).toHaveLength(2);
    expect(fs.readFileSync(source, "utf8")).toBe(edited);
    expect(lines).toContain("slopguard: [2/4] pending       calc.ts:2:9 negate_conditional");
  });

  it("keeps ignored mutants ignored after a file changed", async () => {
    fs.writeFileSync(source, CALC.replace("return a - b;", "return a - b; // slopguard-ignore-mutant"));
    const runner = new FakeCommandRunner([outcome({ exitCode: 0 })], source);
    runner.onRun = (call) => {
      if (call === 1) fs.writeFileSync(source, CALC);
    };
    const report = await pipeline(runner).run({ sourcePath: source, coverage: false });
    expect(report.mutants.map((m) => m.status)).toEqual(["pending", "pending", "ignored", "pending"]);
  });

  it("skips ignored mutants inside a real run", async () => {
    fs.writeFileSync(source, CALC.replace("if (a > b) {", "if (a > b) { // slopguard-ignore-mutant(boundary)"));
    const runner = new FakeCommandRunner([outcome({ exitCode: 0 }), outcome(), outcome(), outcome()], source);
    const report = await pipeline(runner).run({ sourcePath: source, coverage: false, progress });
    expect(report.mutants.map((m) => m.status)).toEqual(["ignored", "killed", "killed", "killed"]);
    expect(runner.calls).toHaveLength(4);
    expect(lines).toContain("slopguard: [1/4] ignored       calc.ts:2:9 boundary");
  });

  it("notes when every tested mutant survived and when mutants did not compile", async () => {
    const survivors = new FakeCommandRunner(
      [outcome({ exitCode: 0 }), ...Array.from({ length: 4 }, () => outcome({ exitCode: 0 }))],
      source
    );
    const report = await pipeline(survivors).run({ sourcePath: source, coverage: false });
    expect(report.notes).toEqual([NOTE_ALL_SURVIVED]);

    const typeError = outcome({
      outputTail: "● Test suite failed to run\n\n    src/calc.ts:2:9 - error TS2365: Operator '>=' cannot be applied",
    });
    const typeErrors = new FakeCommandRunner([outcome({ exitCode: 0 }), typeError, outcome(), outcome(), outcome()], source);
    const withErrors = await pipeline(typeErrors).run({ sourcePath: source, coverage: false, runner: "jest" });
    expect(withErrors.summary.compileErrors).toBe(1);
    expect(withErrors.notes).toEqual(["1 mutant(s) did not compile and are excluded from the score."]);

    const allErrors = new FakeCommandRunner([outcome({ exitCode: 0 }), typeError, typeError, typeError, typeError], source);
    const noneTested = await pipeline(allErrors).run({ sourcePath: source, coverage: false, runner: "jest" });
    expect(noneTested.notes).toEqual(["4 mutant(s) did not compile and are excluded from the score."]);
  });

  it("plans again after restoring a file an interrupted run left mutated", async () => {
    const mutated = CALC.replace("return a - b;", "return a + b;");
    const dir = guardDirectory(project, tmpRoot);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "lock"), "999999");
    fs.writeFileSync(path.join(dir, "original"), CALC);
    const mutantSha256 = createHash("sha256").update(mutated).digest("hex");
    fs.writeFileSync(path.join(dir, "journal.json"), JSON.stringify({ file: source, mutantSha256 }));
    fs.writeFileSync(source, mutated);

    const runner = new FakeCommandRunner([outcome({ exitCode: 0 }), outcome(), outcome(), outcome(), outcome()], source);
    const report = await pipeline(runner).run({ sourcePath: source, coverage: false });
    expect(report.notes).toEqual([`Restored ${source}, which an interrupted mutate run left mutated.`]);
    expect(report.mutants.find((m) => m.line === 3)!.original).toBe("-");
    expect(fs.readFileSync(source, "utf8")).toBe(CALC);
  });

  it("restores and exits on a signal in the middle of a mutant run", async () => {
    const runner = new FakeCommandRunner([outcome({ exitCode: 0 }), outcome()], source);
    runner.onRun = (call) => {
      if (call !== 2) return;
      expect(fs.readFileSync(source, "utf8")).not.toBe(CALC);
      signals.get("SIGINT")!();
    };
    await expect(pipeline(runner).run({ sourcePath: source, coverage: false, progress })).rejects.toThrow("exit 130");
    expect(exits).toEqual([130]);
    expect(guardAtExit).toEqual([false]);
    expect(runner.killed).toBe(1);
    expect(fs.readFileSync(source, "utf8")).toBe(CALC);
    expect(lines).toContain(`slopguard: interrupted — restored ${source}`);
    expect(fs.existsSync(guardDirectory(project, tmpRoot))).toBe(false);
  });

  it("exits on a signal during the baseline, with nothing to restore", async () => {
    const runner = new FakeCommandRunner([outcome({ exitCode: 0 })], source);
    runner.onRun = () => signals.get("SIGHUP")!();
    await expect(pipeline(runner).run({ sourcePath: source, coverage: false, progress })).rejects.toThrow("exit 129");
    expect(lines).toContain("slopguard: interrupted");
    expect(guardAtExit).toEqual([false]);
    expect(fs.readFileSync(source, "utf8")).toBe(CALC);
  });

  it("reports a failed restore from the signal handler on stderr and exits 1", async () => {
    const runner = new FakeCommandRunner([outcome({ exitCode: 0 })], source);
    runner.onRun = () => {
      vi.spyOn(WorkspaceGuard.prototype, "restore").mockImplementationOnce(() => {
        throw SlopguardError.restoreFailed(source, "/tmp/backup", "EIO");
      });
      signals.get("SIGTERM")!();
    };
    await expect(pipeline(runner).run({ sourcePath: source, coverage: false, progress })).rejects.toThrow("exit 1");
    expect(exits).toEqual([1]);
    expect(errors).toEqual([
      `slopguard-typescript: [restore_failed] Could not restore ${source} after mutation: EIO. The original is saved at /tmp/backup.`,
    ]);
    expect(lines).not.toContain("slopguard: interrupted");
  });

  it("wraps unreadable source files in unreadable_file", async () => {
    fs.chmodSync(source, 0o000);
    try {
      await expect(new MutationPipeline().run({ sourcePath: path.join(project, "src"), dryRun: true })).rejects.toMatchObject({
        code: "unreadable_file",
      });
    } finally {
      fs.chmodSync(source, 0o644);
    }
  });

  it("uses the real process hooks by default", () => {
    const hooksInUse = new MutationPipeline().hooks;
    const handler = () => {};
    hooksInUse.on("SIGHUP", handler);
    expect(process.listeners("SIGHUP")).toContain(handler);
    hooksInUse.off("SIGHUP", handler);
    expect(process.listeners("SIGHUP")).not.toContain(handler);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    hooksInUse.exit(129);
    expect(exit).toHaveBeenCalledWith(129);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    hooksInUse.stderr("restore failed");
    expect(write).toHaveBeenCalledWith("restore failed\n");
  });
});

describe("classify", () => {
  const typeCheckFailure = "● Test suite failed to run\n    src/a.ts:1:1 - error TS2322: Type 'number' is not assignable";

  it("maps outcomes to statuses", () => {
    expect(classify(outcome({ timedOut: true, exitCode: null }), "vitest")).toBe("timeout");
    expect(classify(outcome({ exitCode: 0 }), "vitest")).toBe("survived");
    expect(classify(outcome({ exitCode: 1, outputTail: "AssertionError" }), "vitest")).toBe("killed");
  });

  it("reports compile_error only for a jest suite that failed on a type error", () => {
    expect(classify(outcome({ exitCode: 1, outputTail: typeCheckFailure }), "jest")).toBe("compile_error");
    expect(classify(outcome({ exitCode: 1, outputTail: "expected 'error TS2322: Type'" }), "jest")).toBe("killed");
    expect(classify(outcome({ exitCode: 1, outputTail: "● Test suite failed to run\n  ReferenceError" }), "jest")).toBe(
      "killed"
    );
    expect(classify(outcome({ exitCode: 1, outputTail: typeCheckFailure }), "vitest")).toBe("killed");
  });
});
