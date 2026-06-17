import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisPipeline, coverageSourceFromFlags } from "../src/coverage/analysisPipeline.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "slopguard-pipe-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "calc.ts"),
    `export function calc(a: number, b: number): number {
  if (a > b) {
    return a - b;
  }
  return a + b;
}
`
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("AnalysisPipeline", () => {
  it("runs complexity-only with coverage none", async () => {
    const report = await new AnalysisPipeline().run({
      sourcePath: path.join(root, "src"),
      coverage: { mode: "none" },
    });
    expect(report.coverageAvailable).toBe(false);
    expect(report.coverageDataPath).toBeNull();
    expect(report.summary.methodCount).toBe(1);
    expect(report.methods[0]!.qualifiedName).toBe("calc");
    expect(report.methods[0]!.coverage).toBe(0);
  });

  it("joins a prebuilt istanbul coverage file", async () => {
    const covPath = path.join(root, "coverage-final.json");
    const sourceAbs = path.join(root, "src", "calc.ts");
    await writeFile(
      covPath,
      JSON.stringify({
        [sourceAbs]: {
          path: sourceAbs,
          statementMap: {
            "0": { start: { line: 2, column: 2 }, end: { line: 2, column: 10 } },
            "1": { start: { line: 3, column: 4 }, end: { line: 3, column: 16 } },
            "2": { start: { line: 5, column: 2 }, end: { line: 5, column: 14 } },
          },
          fnMap: {},
          branchMap: {},
          s: { "0": 2, "1": 1, "2": 1 },
          f: {},
          b: {},
        },
      })
    );
    const report = await new AnalysisPipeline().run({
      sourcePath: path.join(root, "src"),
      coverage: { mode: "prebuilt", coverageFile: covPath },
    });
    expect(report.coverageAvailable).toBe(true);
    expect(report.coverageDataPath).toBe(covPath);
    expect(report.methods[0]!.coverage).toBe(100);
    expect(report.summary.weightedCoverage).toBeGreaterThan(0);
  });

  it("notes and degrades to 0% when the prebuilt file is empty", async () => {
    const covPath = path.join(root, "coverage-final.json");
    await writeFile(covPath, "{}");
    const report = await new AnalysisPipeline().run({
      sourcePath: path.join(root, "src"),
      coverage: { mode: "prebuilt", coverageFile: covPath },
    });
    expect(report.coverageAvailable).toBe(false);
    expect(report.notes.some((n) => n.includes("no per-file coverage data"))).toBe(true);
    expect(report.methods[0]!.coverage).toBe(0);
  });

  it("fails with unreadable_file for a missing prebuilt file", async () => {
    await expect(
      new AnalysisPipeline().run({
        sourcePath: path.join(root, "src"),
        coverage: { mode: "prebuilt", coverageFile: path.join(root, "nope.json") },
      })
    ).rejects.toMatchObject({ code: "unreadable_file" });
  });

  it("fails with runner_not_detected in auto mode on a runner-less project", async () => {
    await writeFile(path.join(root, "package.json"), "{}");
    await expect(
      new AnalysisPipeline().run({
        sourcePath: path.join(root, "src"),
        coverage: { mode: "auto" },
      })
    ).rejects.toMatchObject({ code: "runner_not_detected" });
  });
});

describe("coverageSourceFromFlags", () => {
  it("maps --no-coverage to none and wins over other flags", () => {
    expect(coverageSourceFromFlags({ noCoverage: true, coverageFile: "x.json" })).toEqual({
      mode: "none",
    });
  });

  it("maps --coverage-file to prebuilt with an absolute path", () => {
    const source = coverageSourceFromFlags({
      noCoverage: false,
      coverageFile: "cov/coverage-final.json",
      cwd: "/work",
    });
    expect(source).toEqual({
      mode: "prebuilt",
      coverageFile: path.resolve("/work", "cov/coverage-final.json"),
    });
  });

  it("defaults to auto, passing runner and project dir through", () => {
    const source = coverageSourceFromFlags({
      noCoverage: false,
      runner: "jest",
      projectDir: "packages/core",
      cwd: "/work",
    });
    expect(source).toEqual({
      mode: "auto",
      runner: "jest",
      projectDir: path.resolve("/work", "packages/core"),
    });
  });

  it("leaves projectDir undefined for discovery when not passed", () => {
    const source = coverageSourceFromFlags({ noCoverage: false });
    expect(source).toEqual({ mode: "auto", runner: undefined, projectDir: undefined });
  });
});
