import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAnalyze, type AnalyzeFlags } from "../src/cli/analyze.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const todoSrc = path.join(repoRoot, "sample-apps", "todo-list", "src");

/**
 * These exercise `runAnalyze` **in-process** so coverage instrumentation sees
 * it run. The CLI integration tests spawn a subprocess, which is why they leave
 * this orchestration function at 0% measured coverage. Every run here uses
 * `--no-coverage` (coverage: false) so the pipeline never spawns a test runner —
 * fast and deterministic.
 */
describe("runAnalyze (in-process)", () => {
  let stdout: string[];
  let stderr: string[];
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = savedExitCode;
  });

  function flags(overrides: Partial<AnalyzeFlags> = {}): AnalyzeFlags {
    return {
      path: todoSrc,
      threshold: "30",
      coverage: false, // commander's --no-coverage
      include: [],
      exclude: [],
      defaultExcludes: true,
      json: false,
      verbose: false,
      quiet: true,
      ...overrides,
    };
  }

  it("prints a pretty report and leaves exit code unset on success", async () => {
    await runAnalyze(flags());
    const out = stdout.join("");
    expect(out).toContain("slopguard-typescript");
    expect(out).toContain("threshold:");
    expect(process.exitCode).toBeUndefined();
  });

  it("emits valid JSON when --json is set", async () => {
    await runAnalyze(flags({ json: true }));
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.schemaVersion).toBe("2");
    expect(parsed.coverageAvailable).toBe(false);
    expect(parsed.methods.length).toBeGreaterThan(0);
  });

  it("rejects a non-numeric --threshold with exit code 1", async () => {
    await runAnalyze(flags({ threshold: "abc" }));
    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toContain("--threshold");
  });

  it("rejects a non-numeric --fail-over with exit code 1", async () => {
    await runAnalyze(flags({ failOver: "nope" }));
    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toContain("--fail-over");
  });

  it("rejects an unsupported --runner with exit code 1", async () => {
    await runAnalyze(flags({ runner: "mocha" }));
    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toContain("not supported");
  });

  it("exits 2 when a method's CRAP exceeds --fail-over", async () => {
    // --no-coverage assumes 0% coverage, so even tiny methods clear a 0.5 bar.
    await runAnalyze(flags({ failOver: "0.5" }));
    expect(process.exitCode).toBe(2);
    expect(stderr.join("")).toContain("exceeds --fail-over");
  });

  it("does not exit 2 when CRAP stays under --fail-over", async () => {
    await runAnalyze(flags({ failOver: "100000" }));
    expect(process.exitCode).toBeUndefined();
  });

  it("emits a coded error and exits 1 when the pipeline fails", async () => {
    await runAnalyze(flags({ path: "/nonexistent/slopguard-test", json: true }));
    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(stderr.join(""));
    expect(parsed.error.code).toBe("file_not_found");
  });

  it("uses default analysis options when no globs and --no-default-excludes are given", async () => {
    // defaultExcludes:false + empty include/exclude → the empty-options branch
    // that falls back to defaultAnalysisOptions().
    await runAnalyze(flags({ json: true, defaultExcludes: false }));
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.methods.length).toBeGreaterThan(0);
  });

  it("threads include/exclude globs through the options branch", async () => {
    await runAnalyze(flags({ json: true, include: ["**/*.ts"], exclude: ["**/todoFilter.ts"] }));
    const parsed = JSON.parse(stdout.join(""));
    const files: string[] = parsed.methods.map((m: { file: string }) => m.file);
    expect(files.some((f) => f.includes("todoFilter"))).toBe(false);
    expect(files.some((f) => f.includes("todoStore"))).toBe(true);
  });
});
