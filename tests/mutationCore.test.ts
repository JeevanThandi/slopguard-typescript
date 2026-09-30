import { describe, expect, it } from "vitest";
import { makeMethodMetric } from "../src/core/models.js";
import { isIgnored, parseIgnoreMarkers } from "../src/core/mutation/ignoreMarkers.js";
import {
  applyMutant,
  compareSites,
  MutantResult,
  MutantStatus,
  mutantId,
  summarize,
} from "../src/core/mutation/models.js";
import { enclosingMethod, MutationPlanner } from "../src/core/mutation/mutationPlanner.js";
import { isMutationOperator, MUTATION_OPERATORS, parseOperators } from "../src/core/mutation/operators.js";
import { SlopguardError } from "../src/core/errors.js";

describe("operators", () => {
  it("defaults to every operator, sorted", () => {
    expect(parseOperators([])).toEqual([...MUTATION_OPERATORS]);
    expect(parseOperators([" , "])).toEqual([...MUTATION_OPERATORS]);
    expect([...MUTATION_OPERATORS].sort()).toEqual([...MUTATION_OPERATORS]);
  });

  it("accepts comma-separated and repeated ids, de-duplicated and sorted", () => {
    expect(parseOperators(["logical, boundary", "boundary"])).toEqual(["boundary", "logical"]);
  });

  it("rejects unknown ids with invalid_argument", () => {
    let caught: unknown;
    try {
      parseOperators(["boundary,nope,alsonope"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SlopguardError);
    expect((caught as SlopguardError).code).toBe("invalid_argument");
    expect((caught as SlopguardError).message).toContain("nope, alsonope");
  });

  it("recognises operator ids", () => {
    expect(isMutationOperator("remove_call")).toBe(true);
    expect(isMutationOperator("remove-call")).toBe(false);
  });
});

function result(status: MutantStatus): MutantResult {
  return {
    id: "a.ts:1:1:boundary",
    file: "a.ts",
    line: 1,
    column: 1,
    operator: "boundary",
    original: "<",
    replacement: "<=",
    method: null,
    status,
  };
}

describe("mutation models", () => {
  it("builds ids from file, position and operator", () => {
    expect(mutantId({ file: "src/a.ts", line: 3, column: 7, operator: "logical" })).toBe("src/a.ts:3:7:logical");
  });

  it("orders by file, line, column, then operator", () => {
    const base = { file: "b.ts", line: 2, column: 5, operator: "boundary" as const };
    expect(compareSites(base, { ...base, file: "a.ts" })).toBeGreaterThan(0);
    expect(compareSites(base, { ...base, file: "c.ts" })).toBeLessThan(0);
    expect(compareSites(base, { ...base, line: 1 })).toBeGreaterThan(0);
    expect(compareSites({ ...base, line: 1 }, base)).toBeLessThan(0);
    expect(compareSites(base, { ...base })).toBe(0);
    expect(compareSites(base, { ...base, column: 9 })).toBeLessThan(0);
    expect(compareSites(base, { ...base, operator: "arithmetic" })).toBeGreaterThan(0);
    expect(compareSites(base, { ...base, operator: "negate_conditional" })).toBeLessThan(0);
  });

  it("applies a mutant by replacing its span", () => {
    expect(applyMutant("a < b", { start: 2, end: 3, replacement: "<=" })).toBe("a <= b");
  });

  it("counts every status and scores detected over scored", () => {
    const statuses: MutantStatus[] = [
      "killed",
      "killed",
      "timeout",
      "survived",
      "no_coverage",
      "compile_error",
      "ignored",
      "pending",
    ];
    const summary = summarize(statuses.map(result), 4);
    expect(summary).toEqual({
      fileCount: 4,
      mutantCount: 8,
      killed: 2,
      survived: 1,
      timedOut: 1,
      noCoverage: 1,
      compileErrors: 1,
      ignored: 1,
      pending: 1,
      mutationScore: 60,
    });
  });

  it("has no score when nothing counts towards it", () => {
    expect(summarize(["compile_error", "ignored", "pending"].map((s) => result(s as MutantStatus)), 1).mutationScore).toBeNull();
    expect(summarize([], 0).mutationScore).toBeNull();
  });
});

describe("ignore markers", () => {
  it("finds a marker at the very start of a line", () => {
    const map = parseIgnoreMarkers(["slopguard-ignore-mutant(boundary) inside a template literal"]);
    expect(isIgnored(map, 1, "boundary")).toBe(true);
  });

  it("ignores every operator on the marker's line", () => {
    const map = parseIgnoreMarkers(["const a = b < c; // slopguard-ignore-mutant: equivalent"]);
    expect(isIgnored(map, 1, "boundary")).toBe(true);
    expect(isIgnored(map, 1, "remove_call")).toBe(true);
    expect(isIgnored(map, 2, "boundary")).toBe(false);
  });

  it("narrows to listed operators and drops unknown ids", () => {
    const map = parseIgnoreMarkers(["x < y; // slopguard-ignore-mutant( boundary , nope,logical): reason"]);
    expect(isIgnored(map, 1, "boundary")).toBe(true);
    expect(isIgnored(map, 1, "logical")).toBe(true);
    expect(isIgnored(map, 1, "negate_conditional")).toBe(false);
  });

  it("reads an unclosed list to the end of the line, and an empty list ignores nothing", () => {
    const map = parseIgnoreMarkers(["a; // slopguard-ignore-mutant(boundary", "b; // slopguard-ignore-mutant()"]);
    expect(isIgnored(map, 1, "boundary")).toBe(true);
    expect(isIgnored(map, 2, "boundary")).toBe(false);
  });

  it("applies a comment-only marker line to the next line", () => {
    const map = parseIgnoreMarkers([
      "  // slopguard-ignore-mutant(boundary)",
      "  if (a < b) {}",
      "  /* slopguard-ignore-mutant */",
      "  f();",
      "   * slopguard-ignore-mutant(logical)",
      "  a && b;",
    ]);
    expect(isIgnored(map, 1, "boundary")).toBe(false);
    expect(isIgnored(map, 2, "boundary")).toBe(true);
    expect(isIgnored(map, 4, "remove_call")).toBe(true);
    expect(isIgnored(map, 6, "logical")).toBe(true);
  });

  it("merges markers that target the same line", () => {
    const union = parseIgnoreMarkers([
      "// slopguard-ignore-mutant(boundary)",
      "a < b; // slopguard-ignore-mutant(logical)",
    ]);
    expect(isIgnored(union, 2, "boundary")).toBe(true);
    expect(isIgnored(union, 2, "logical")).toBe(true);
    expect(isIgnored(union, 2, "arithmetic")).toBe(false);
    const all = parseIgnoreMarkers(["// slopguard-ignore-mutant(boundary)", "a < b; // slopguard-ignore-mutant"]);
    expect(isIgnored(all, 2, "arithmetic")).toBe(true);
    const allFirst = parseIgnoreMarkers(["// slopguard-ignore-mutant", "a < b; // slopguard-ignore-mutant(boundary)"]);
    expect(isIgnored(allFirst, 2, "arithmetic")).toBe(true);
  });

  it("treats a leading * as a comment only before whitespace, / or the end of the line", () => {
    const map = parseIgnoreMarkers([
      "  *gen() { yield a < b; } // slopguard-ignore-mutant(boundary)",
      "  * slopguard-ignore-mutant(logical)",
      "  a && b;",
      "  */ // slopguard-ignore-mutant(remove_not)",
      "  !a;",
    ]);
    expect(isIgnored(map, 1, "boundary")).toBe(true);
    expect(isIgnored(map, 2, "boundary")).toBe(false);
    expect(isIgnored(map, 3, "logical")).toBe(true);
    expect(isIgnored(map, 5, "remove_not")).toBe(true);
  });

  it("takes a custom comment-only pattern", () => {
    const map = parseIgnoreMarkers(["# slopguard-ignore-mutant", "x = not y"], /^#/);
    expect(isIgnored(map, 2, "remove_not")).toBe(true);
  });
});

describe("MutationPlanner", () => {
  const source = [
    "export class Store {",
    "  add(a: number, b: number) {",
    "    // slopguard-ignore-mutant(boundary)",
    "    const inner = () => a < b;",
    "    return a + b;",
    "  }",
    "}",
    "export const top = 1 + 2;",
  ].join("\n");

  it("plans sorted mutants with their enclosing method and ignore flags", () => {
    const planned = new MutationPlanner().plan(source, "store.ts", MUTATION_OPERATORS);
    expect(
      planned.map((p) => `${p.site.line}:${p.site.column} ${p.site.operator} ${p.method} ${p.ignored}`)
    ).toEqual([
      "4:27 boundary Store.inner true",
      "4:27 negate_conditional Store.inner false",
      "5:14 arithmetic Store.add false",
      "8:22 arithmetic null false",
    ]);
  });

  it("names the inner function when nested functions share one line", () => {
    const planned = new MutationPlanner().plan(
      "export function outer() { const inner = () => a < b; return inner; }",
      "one.ts",
      ["boundary"]
    );
    expect(planned.map((p) => p.method)).toEqual(["inner"]);
  });

  it("keeps only the requested operators", () => {
    const planned = new MutationPlanner().plan(source, "store.ts", ["arithmetic"]);
    expect(planned.map((p) => p.site.operator)).toEqual(["arithmetic", "arithmetic"]);
  });

  it("picks the innermost method, and the later one on a tie", () => {
    const method = (name: string, startLine: number, endLine: number) =>
      makeMethodMetric({
        name,
        qualifiedName: name,
        typeName: null,
        kind: "function",
        file: "x.ts",
        startLine,
        endLine,
        complexity: 1,
        cognitiveComplexity: 0,
      });
    const methods = [method("outer", 1, 10), method("first", 2, 4), method("second", 3, 5)];
    expect(enclosingMethod(methods, 3)).toBe("second");
    expect(enclosingMethod(methods, 2)).toBe("first");
    expect(enclosingMethod(methods, 9)).toBe("outer");
    expect(enclosingMethod(methods, 11)).toBeNull();
    // Order-independent: a wider or earlier candidate never displaces the innermost.
    expect(enclosingMethod([methods[1]!, methods[0]!], 3)).toBe("first");
    expect(enclosingMethod([methods[2]!, methods[1]!], 3)).toBe("second");
  });
});
