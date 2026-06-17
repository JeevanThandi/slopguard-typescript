import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisPipeline } from "../src/coverage/analysisPipeline.js";
import { DirectoryAnalyzer } from "../src/core/analysis/directoryAnalyzer.js";
import { CrapAggregator } from "../src/core/aggregation/crapAggregator.js";
import type { TestRunner, TestRunOutcome } from "../src/coverage/testRunner.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A TestRunner stand-in: returns a canned outcome (or throws) without spawning. */
function fakeRunner(outcome: TestRunOutcome | (() => never)): TestRunner {
  return {
    runTests: async () => {
      if (typeof outcome === "function") return outcome();
      return outcome;
    },
  } as unknown as TestRunner;
}

function pipelineWith(runner: TestRunner): AnalysisPipeline {
  return new AnalysisPipeline(new DirectoryAnalyzer(), runner, new CrapAggregator());
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "slopguard-auto-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", devDependencies: { vitest: "*" } })
  );
  await writeFile(
    path.join(root, "src", "calc.ts"),
    `export function calc(a: number, b: number): number {\n  if (a > b) { return a - b; }\n  return a + b;\n}\n`
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("AnalysisPipeline auto mode", () => {
  it("notes a failing suite and hides the ephemeral coverage path", async () => {
    const sourceAbs = path.join(root, "src", "calc.ts");
    const covPath = path.join(root, "coverage-final.json");
    await writeFile(
      covPath,
      JSON.stringify({
        [sourceAbs]: {
          path: sourceAbs,
          statementMap: { "0": { start: { line: 2, column: 2 }, end: { line: 2, column: 10 } } },
          fnMap: {},
          branchMap: {},
          s: { "0": 1 },
          f: {},
          b: {},
        },
      })
    );
    const pipeline = pipelineWith(fakeRunner({ coverageJsonPath: covPath, testsPassed: false }));
    const report = await pipeline.run({
      sourcePath: path.join(root, "src"),
      coverage: { mode: "auto", runner: "vitest", projectDir: root },
    });
    expect(report.coverageAvailable).toBe(true);
    // Ephemeral (auto-mode) coverage is cleaned up, so its path is not surfaced.
    expect(report.coverageDataPath).toBeNull();
    expect(report.notes.some((n) => n.includes("Some tests failed"))).toBe(true);
  });

  it("auto-detects the runner and notes when no coverage json is produced", async () => {
    // No explicit runner + no projectDir → discoverProjectRoot + detectRunner.
    const pipeline = pipelineWith(fakeRunner({ coverageJsonPath: null, testsPassed: true }));
    const report = await pipeline.run({
      sourcePath: path.join(repoRoot, "src"),
      coverage: { mode: "auto" },
    });
    expect(report.coverageAvailable).toBe(false);
    expect(report.notes.some((n) => n.includes("no coverage data was produced"))).toBe(true);
    expect(report.methods.every((m) => m.coverage === 0)).toBe(true);
  });

  it("defaults to auto mode when no coverage source is given", async () => {
    const pipeline = pipelineWith(fakeRunner({ coverageJsonPath: null, testsPassed: true }));
    // No `coverage` key at all → run() falls back to { mode: "auto" }.
    const report = await pipeline.run({ sourcePath: path.join(root, "src") });
    expect(report.coverageAvailable).toBe(false);
  });

  it("cleans up and rethrows when the runner fails", async () => {
    const pipeline = pipelineWith(
      fakeRunner(() => {
        throw new Error("runner exploded");
      })
    );
    await expect(
      pipeline.run({
        sourcePath: path.join(root, "src"),
        coverage: { mode: "auto", runner: "vitest", projectDir: root },
      })
    ).rejects.toThrow("runner exploded");
  });
});
