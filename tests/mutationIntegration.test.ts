import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MutationPipeline } from "../src/mutation/mutationPipeline.js";

const exec = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const todoList = path.join(repoRoot, "sample-apps", "todo-list");
const cli = path.join(repoRoot, "dist", "cli", "main.js");

/**
 * A private copy of the todo-list fixture (its node_modules symlinked in).
 * `mutate` edits sources in place, and other test files run the real
 * fixture's tests in parallel, so the mutation run must not touch it.
 */
function copyTodoList(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopguard-todo-"));
  for (const entry of ["package.json", "vitest.config.ts", "src", "tests"]) {
    fs.cpSync(path.join(todoList, entry), path.join(dir, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(todoList, "node_modules"), path.join(dir, "node_modules"), "dir");
  return dir;
}

/**
 * The todo-list fixture is the mutation baseline too: every mutant its source
 * yields is killed by its tests. A survivor here means either the generator
 * started producing a new mutant or the fixture's tests lost an assertion.
 */
describe("mutate end-to-end against sample-apps/todo-list", () => {
  it("kills every mutant with the fixture's own vitest", async () => {
    const copy = copyTodoList();
    try {
      const before = fs.readFileSync(path.join(copy, "src", "todoStore.ts"), "utf8");
      const report = await new MutationPipeline().run({ sourcePath: path.join(copy, "src") });
      expect(report.coverageAvailable).toBe(true);
      expect(report.runner).toBe("vitest");
      expect(report.notes).toEqual([]);
      expect(report.summary).toMatchObject({ fileCount: 3, mutantCount: 7, killed: 7, survived: 0, mutationScore: 100 });
      expect(fs.readFileSync(path.join(copy, "src", "todoStore.ts"), "utf8")).toBe(before);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(!fs.existsSync(cli))("lists mutants as JSON in a dry run", async () => {
    const { stdout } = await exec(process.execPath, [
      cli,
      "mutate",
      "--path",
      path.join(todoList, "src"),
      "--dry-run",
      "--json",
      "--quiet",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.reportType).toBe("mutation");
    expect(parsed.summary.pending).toBe(7);
  });
});

/**
 * A project whose `vitest` is a shell script: the first run (the baseline)
 * passes at once, every later run (a mutant) hangs. That makes timeouts and
 * signals testable against real processes.
 */
describe.skipIf(process.platform === "win32" || !fs.existsSync(cli))("mutate with a hanging test runner", () => {
  const ORIGINAL = "export const big = (a: number): boolean => a > 1;\n";
  let project: string;
  let sourceFile: string;
  let countFile: string;

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "slopguard-hang-"));
    sourceFile = path.join(project, "src", "big.ts");
    countFile = path.join(project, "count");
    fs.mkdirSync(path.join(project, "src"));
    fs.mkdirSync(path.join(project, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ devDependencies: { vitest: "*" } }));
    fs.writeFileSync(sourceFile, ORIGINAL);
    const script = [
      "#!/bin/sh",
      `n=$(cat "${countFile}" 2>/dev/null || echo 0)`,
      `echo $((n + 1)) > "${countFile}"`,
      'if [ "$n" -ge 1 ]; then exec sleep 60; fi',
      "exit 0",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(project, "node_modules", ".bin", "vitest"), script, { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("records hanging mutants as timeouts and restores the source", async () => {
    const { stdout } = await exec(process.execPath, [
      cli,
      "mutate",
      "--path",
      path.join(project, "src"),
      "--no-coverage",
      "--timeout",
      "1",
      "--json",
      "--quiet",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.mutants.map((m: { status: string }) => m.status)).toEqual(["timeout", "timeout"]);
    expect(parsed.summary.mutationScore).toBe(100);
    expect(fs.readFileSync(sourceFile, "utf8")).toBe(ORIGINAL);
  }, 60_000);

  it("restores the source and exits 130 on SIGINT", async () => {
    const child = spawn(process.execPath, [cli, "mutate", "--path", path.join(project, "src"), "--no-coverage"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));

    for (let i = 0; i < 200 && Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : 0) < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(fs.readFileSync(sourceFile, "utf8")).not.toBe(ORIGINAL);
    child.kill("SIGINT");

    expect(await exited).toBe(130);
    expect(fs.readFileSync(sourceFile, "utf8")).toBe(ORIGINAL);
    expect(stderr).toContain(`slopguard: interrupted — restored ${sourceFile}`);
  }, 60_000);
});
