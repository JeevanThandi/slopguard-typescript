import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli/main.js";
import { MutateFlags, mutateArgsFromFlags, runMutate } from "../src/cli/mutate.js";
import { SlopguardError } from "../src/core/errors.js";
import { MutantResult, MutationReport, summarize } from "../src/core/mutation/models.js";
import type { MutationPipeline } from "../src/mutation/mutationPipeline.js";
import * as sg from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const todoSrc = path.join(repoRoot, "sample-apps", "todo-list", "src");

function flags(overrides: Partial<MutateFlags> = {}): MutateFlags {
  return {
    path: todoSrc,
    include: [],
    exclude: [],
    defaultExcludes: true,
    operators: [],
    coverage: true,
    dryRun: false,
    json: false,
    verbose: false,
    quiet: true,
    ...overrides,
  };
}

function report(statuses: MutantResult["status"][]): MutationReport {
  const mutants = statuses.map(
    (status, i): MutantResult => ({
      id: `a.ts:${i + 1}:1:boundary`,
      file: "a.ts",
      line: i + 1,
      column: 1,
      operator: "boundary",
      original: "<",
      replacement: "<=",
      method: null,
      status,
    })
  );
  return {
    schemaVersion: "1",
    reportType: "mutation",
    tool: "slopguard-typescript",
    toolVersion: "0.2.0",
    generatedAt: "2026-09-30T12:00:00.000Z",
    sourceRoot: "/p",
    projectRoot: "/p",
    runner: "vitest",
    timeoutSeconds: 10,
    coverageAvailable: true,
    operators: ["boundary"],
    notes: [],
    summary: summarize(mutants, 1),
    mutants,
  };
}

const fakePipeline = (result: MutationReport | Error) =>
  ({
    run: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  }) as unknown as MutationPipeline;

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

describe("mutateArgsFromFlags", () => {
  it("resolves paths, globs, operators and numbers", () => {
    const { args, failUnder } = mutateArgsFromFlags(
      flags({
        path: "~/x",
        projectDir: "~/proj",
        include: ["src/**"],
        exclude: ["**/legacy/**"],
        operators: ["logical,boundary"],
        runner: "jest",
        coverage: false,
        timeout: "12",
        failUnder: "75.5",
        dryRun: true,
      })
    );
    expect(args).toMatchObject({
      sourcePath: path.join(os.homedir(), "x"),
      projectDir: path.join(os.homedir(), "proj"),
      operators: ["boundary", "logical"],
      runner: "jest",
      coverage: false,
      timeoutSeconds: 12,
      dryRun: true,
    });
    expect(args.options!.includeGlobs).toEqual(["src/**"]);
    expect(args.options!.excludeGlobs).toContain("**/node_modules/**");
    expect(args.options!.excludeGlobs.at(-1)).toBe("**/legacy/**");
    expect(failUnder).toBe(75.5);
  });

  it("drops the default excludes on request and leaves optional values unset", () => {
    const { args, failUnder } = mutateArgsFromFlags(flags({ defaultExcludes: false, exclude: ["x/**"] }));
    expect(args.options!.excludeGlobs).toEqual(["x/**"]);
    expect(args.projectDir).toBeUndefined();
    expect(args.timeoutSeconds).toBeUndefined();
    expect(failUnder).toBeNull();
  });

  it.each([
    [{ timeout: "0" }, "--timeout"],
    [{ timeout: "soon" }, "--timeout"],
    [{ failUnder: "high" }, "--fail-under"],
    [{ runner: "mocha" }, "--runner"],
    [{ operators: ["flip"] }, "--operators"],
  ])("rejects %j", (bad, name) => {
    expect(() => mutateArgsFromFlags(flags(bad as Partial<MutateFlags>))).toThrow(name);
  });
});

describe("runMutate", () => {
  it("prints the text report and leaves the exit code unset", async () => {
    await runMutate(flags(), fakePipeline(report(["killed"])));
    expect(stdout.join("")).toContain("mutation report (schema 1)");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints JSON with --json", async () => {
    await runMutate(flags({ json: true }), fakePipeline(report(["killed"])));
    expect(JSON.parse(stdout.join("")).reportType).toBe("mutation");
  });

  it("exits 2 when the score is below --fail-under", async () => {
    await runMutate(flags({ failUnder: "90" }), fakePipeline(report(["killed", "survived"])));
    expect(process.exitCode).toBe(2);
    expect(stderr.join("")).toBe("slopguard-typescript: mutation score 50.00% is below --fail-under 90\n");
  });

  it("passes --fail-under at the threshold, without a score, and in a dry run", async () => {
    await runMutate(flags({ failUnder: "50" }), fakePipeline(report(["killed", "survived"])));
    await runMutate(flags({ failUnder: "90" }), fakePipeline(report(["ignored"])));
    await runMutate(flags({ failUnder: "90", dryRun: true }), fakePipeline(report(["killed", "survived"])));
    expect(process.exitCode).toBeUndefined();
  });

  it("reports flag and pipeline errors with exit 1, as JSON under --json", async () => {
    await runMutate(flags({ timeout: "-1" }), fakePipeline(report([])));
    expect(stderr.join("")).toContain("[invalid_argument] Invalid argument '--timeout'");
    expect(process.exitCode).toBe(1);
    stderr = [];
    await runMutate(flags({ json: true }), fakePipeline(SlopguardError.baselineFailed(1, "boom")));
    expect(JSON.parse(stderr.join("")).error.code).toBe("baseline_failed");
  });
});

describe("mutate command wiring", () => {
  it("registers mutate next to analyze and runs a dry run through commander", async () => {
    const program = buildProgram();
    expect(program.commands.map((c) => c.name())).toContain("mutate");
    await program.parseAsync(["node", "slopguard-ts", "mutate", "--path", todoSrc, "--dry-run", "--json", "--quiet"]);
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.summary.pending).toBe(7);
    expect(parsed.runner).toBeNull();
  });

  it("exports the mutation surface from the barrel", () => {
    expect(typeof sg.MutationPipeline).toBe("function");
    expect(typeof sg.MutantGenerator).toBe("function");
    expect(typeof sg.WorkspaceGuard).toBe("function");
    expect(sg.MUTATION_OPERATORS).toContain("remove_call");
    expect(sg.IGNORE_MARKER).toBe("slopguard-ignore-mutant");
  });
});
