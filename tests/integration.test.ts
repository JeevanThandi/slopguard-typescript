import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AnalysisPipeline } from "../src/coverage/analysisPipeline.js";

const exec = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const todoList = path.join(repoRoot, "sample-apps", "todo-list");
const cli = path.join(repoRoot, "dist", "cli", "main.js");

/**
 * The todo-list fixture is the known-good baseline (mirrors slopguard-swift's
 * SampleApps/TodoList): tiny, fully covered, low complexity. Running the
 * analyzer against it should always produce the same near-zero CRAP report.
 * Drift against that baseline is a regression signal in the analyzer itself.
 */
describe("end-to-end against sample-apps/todo-list", () => {
  it("drives vitest for coverage and reports a fully-covered, low-CRAP baseline", async () => {
    const report = await new AnalysisPipeline().run({
      sourcePath: path.join(todoList, "src"),
      coverage: { mode: "auto" },
    });

    expect(report.coverageAvailable).toBe(true);
    expect(report.summary.fileCount).toBe(3);
    expect(report.summary.methodCount).toBeGreaterThanOrEqual(8);
    expect(report.summary.crappyMethodCount).toBe(0);
    expect(report.summary.crappyTypeCount).toBe(0);
    expect(report.summary.weightedCoverage).toBeGreaterThan(95);
    // Every method individually covered.
    for (const m of report.methods) {
      expect(m.coverage, `${m.qualifiedName} coverage`).toBeGreaterThan(0);
      expect(m.crap, `${m.qualifiedName} crap`).toBeLessThan(30);
    }
  }, 120_000);

  it("honors an explicit --runner choice", async () => {
    const report = await new AnalysisPipeline().run({
      sourcePath: path.join(todoList, "src"),
      coverage: { mode: "auto", runner: "vitest" },
    });
    expect(report.coverageAvailable).toBe(true);
  }, 120_000);
});

describe("CLI end-to-end", () => {
  it.skipIf(!fs.existsSync(cli))("emits valid JSON with --json --no-coverage", async () => {
    const { stdout } = await exec(process.execPath, [
      cli,
      "analyze",
      "--path",
      path.join(todoList, "src"),
      "--no-coverage",
      "--json",
      "--quiet",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.schemaVersion).toBe("2");
    expect(parsed.tool).toBe("slopguard-typescript");
    expect(parsed.coverageAvailable).toBe(false);
    expect(parsed.methods.length).toBeGreaterThan(0);
  });

  it.skipIf(!fs.existsSync(cli))("exits 2 when --fail-over is exceeded", async () => {
    const result = await exec(process.execPath, [
      cli,
      "analyze",
      "--path",
      path.join(todoList, "src"),
      "--no-coverage",
      "--fail-over",
      "0.5",
      "--quiet",
    ]).catch((e: { code: number; stderr: string }) => e);
    expect(result.code).toBe(2);
    expect(String(result.stderr)).toContain("exceeds --fail-over");
  });

  it.skipIf(!fs.existsSync(cli))("exits 1 with a coded error for a missing path", async () => {
    const result = await exec(process.execPath, [
      cli,
      "analyze",
      "--path",
      "/nonexistent/slopguard-test",
      "--no-coverage",
      "--json",
      "--quiet",
    ]).catch((e: { code: number; stderr: string }) => e);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(String(result.stderr));
    expect(parsed.error.code).toBe("file_not_found");
  });

  it.skipIf(!fs.existsSync(cli))("prints version metadata as JSON", async () => {
    const { stdout } = await exec(process.execPath, [cli, "version"]);
    expect(JSON.parse(stdout)).toEqual({ name: "slopguard-typescript", version: "0.1.0" });
  });

  it.skipIf(!fs.existsSync(cli))("rejects an unsupported --runner", async () => {
    const result = await exec(process.execPath, [
      cli,
      "analyze",
      "--path",
      path.join(todoList, "src"),
      "--runner",
      "mocha",
      "--quiet",
    ]).catch((e: { code: number; stderr: string }) => e);
    expect(result.code).toBe(1);
    expect(String(result.stderr)).toContain("not supported");
  });
});
