import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import { buildProgram, main } from "../src/cli/main.js";
import { makeAnalyzeCommand } from "../src/cli/analyze.js";
import * as sg from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const todoSrc = path.join(repoRoot, "sample-apps", "todo-list", "src");

describe("public barrel (index.ts)", () => {
  it("re-exports the documented surface", () => {
    expect(typeof sg.crapScore).toBe("function");
    expect(typeof sg.ComplexityVisitor).toBe("function");
    expect(typeof sg.AnalysisPipeline).toBe("function");
    expect(typeof sg.CrapAggregator).toBe("function");
    expect(typeof sg.prettyReport).toBe("function");
    expect(sg.SUPPORTED_RUNNERS).toContain("vitest");
    expect(sg.DEFAULT_CRAP_THRESHOLD).toBeGreaterThan(0);
  });
});

describe("CLI program wiring (main.ts)", () => {
  let stdout: string[];
  let stderr: string[];
  let savedExit: typeof process.exitCode;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    savedExit = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => (stdout.push(String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => (stderr.push(String(c)), true));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = savedExit;
  });

  it("builds a program named slopguard-ts with a default analyze command", () => {
    const program = buildProgram();
    expect(program.name()).toBe("slopguard-ts");
    const names = program.commands.map((c: Command) => c.name());
    expect(names).toContain("analyze");
    expect(names).toContain("version");
  });

  it("runs the version subcommand and prints JSON metadata", async () => {
    await main(["node", "slopguard-ts", "version"]);
    expect(JSON.parse(stdout.join(""))).toEqual({ name: "slopguard-typescript", version: sg.SlopguardVersion.version });
    expect(process.exitCode).toBeUndefined();
  });

  it("turns a rejected parse into a stderr line and exit code 1", async () => {
    const fakeProgram = { parseAsync: () => Promise.reject(new Error("boom")) } as unknown as Command;
    await main(["node", "slopguard-ts"], fakeProgram);
    expect(stderr.join("")).toContain("boom");
    expect(process.exitCode).toBe(1);
  });
});

describe("makeAnalyzeCommand", () => {
  let stdout: string[];
  let savedExit: typeof process.exitCode;

  beforeEach(() => {
    stdout = [];
    savedExit = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => (stdout.push(String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = savedExit;
  });

  it("parses flags and drives the analyze action end-to-end", async () => {
    const cmd = makeAnalyzeCommand();
    await cmd.parseAsync(["--path", todoSrc, "--no-coverage", "--quiet", "--json"], { from: "user" });
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.schemaVersion).toBe("2");
    expect(parsed.methods.length).toBeGreaterThan(0);
  });
});
