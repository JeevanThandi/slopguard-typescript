import { describe, expect, it } from "vitest";
import {
  jsonMutationReport,
  prettyMutationReport,
  snippet,
} from "../src/core/formatting/mutationReportFormatter.js";
import { MutantResult, MutantStatus, MutationReport, summarize } from "../src/core/mutation/models.js";

function mutant(status: MutantStatus, overrides: Partial<MutantResult> = {}): MutantResult {
  return {
    id: `store.ts:3:9:boundary`,
    file: "store.ts",
    line: 3,
    column: 9,
    operator: "boundary",
    original: "<",
    replacement: "<=",
    method: "Store.add",
    status,
    ...overrides,
  };
}

function report(mutants: MutantResult[], overrides: Partial<MutationReport> = {}): MutationReport {
  return {
    schemaVersion: "1",
    reportType: "mutation",
    tool: "slopguard-typescript",
    toolVersion: "0.2.0",
    generatedAt: "2026-09-30T12:00:00.000Z",
    sourceRoot: "/p/src",
    projectRoot: "/p",
    runner: "vitest",
    timeoutSeconds: 16,
    coverageAvailable: true,
    operators: ["boundary"],
    notes: [],
    summary: summarize(mutants, 2),
    mutants,
    ...overrides,
  };
}

describe("prettyMutationReport", () => {
  it("prints the header, notes, summary and each mutant section in order", () => {
    const text = prettyMutationReport(
      report(
        [
          mutant("killed"),
          mutant("survived", { method: null }),
          mutant("no_coverage", { operator: "remove_call", original: "save(\n  x\n);", replacement: ";" }),
          mutant("timeout", { operator: "increment", original: "++", replacement: "--" }),
          mutant("ignored"),
        ],
        { notes: ["A note."] }
      )
    );
    expect(text).toBe(
      [
        "slopguard-typescript 0.2.0 — mutation report (schema 1)",
        "source:    /p/src",
        "project:   /p",
        "runner:    vitest",
        "timeout:   16s per mutant",
        "",
        "Notes",
        "  • A note.",
        "",
        "Summary",
        "  files:          2",
        "  mutants:        5",
        "  killed:         1",
        "  timed out:      1",
        "  survived:       1",
        "  no coverage:    1",
        "  compile errors: 0",
        "  ignored:        1",
        "  score:          50.00%",
        "",
        "Survived (1) — tests still pass with these changes",
        "  store.ts:3:9  boundary  `<` → `<=`",
        "",
        "No coverage (1) — no test runs these lines",
        "  store.ts:3:9  remove_call  `save( x );` → `;`  Store.add",
        "",
        "Timed out (1) — counted as killed",
        "  store.ts:3:9  increment  `++` → `--`  Store.add",
        "",
      ].join("\n")
    );
  });

  it("shows a dry run: not-run header, pending row, n/a score and the mutant list", () => {
    const text = prettyMutationReport(
      report([mutant("pending", { operator: "remove_not", original: "!", replacement: "" })], {
        projectRoot: null,
        runner: null,
        timeoutSeconds: null,
        coverageAvailable: false,
      })
    );
    expect(text).toContain("project:   (not run)\nrunner:    (not run)\ntimeout:   (not run)\n");
    expect(text).not.toContain("Notes");
    expect(text).toContain("  pending:        1\n  score:          n/a\n");
    expect(text).toContain("Mutants (1, not run)\n  store.ts:3:9  remove_not  `!` → ``  Store.add\n");
  });
});

describe("snippet", () => {
  it("collapses whitespace and keeps short text", () => {
    expect(snippet("a\n\t  b")).toBe("a b");
    expect(snippet("x".repeat(40))).toBe("x".repeat(40));
  });

  it("caps long text at 40 code points with an ellipsis", () => {
    expect(snippet("y".repeat(41))).toBe("y".repeat(39) + "…");
    expect(Array.from(snippet("😀".repeat(50)))).toHaveLength(40);
  });
});

describe("jsonMutationReport", () => {
  it("emits sorted keys, pretty by default", () => {
    const json = jsonMutationReport(report([mutant("killed")]));
    expect(json.startsWith('{\n  "coverageAvailable": true,')).toBe(true);
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed.mutants[0])).toEqual([
      "column",
      "file",
      "id",
      "line",
      "method",
      "operator",
      "original",
      "replacement",
      "status",
    ]);
    expect(parsed.summary.mutationScore).toBe(100);
  });

  it("can emit compact JSON", () => {
    expect(jsonMutationReport(report([]), false)).not.toContain("\n");
  });
});
