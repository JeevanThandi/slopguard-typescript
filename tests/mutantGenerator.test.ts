import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/core/analysis/fileAnalyzer.js";
import { applyMutant } from "../src/core/mutation/models.js";
import { MutantGenerator } from "../src/core/mutation/mutantGenerator.js";

const generate = (source: string, file = "x.ts") => new MutantGenerator().generate(parseSourceFile(source, file), file);

/** `original -> replacement` for every mutant of one operator, in source order. */
const changes = (source: string, operator: string) =>
  generate(source)
    .filter((m) => m.operator === operator)
    .map((m) => `${m.original} -> ${m.replacement}`);

describe("MutantGenerator — arithmetic", () => {
  it("swaps each binary arithmetic operator", () => {
    expect(changes("const r = [a + b, a - b, a * b, a / b, a % b];", "arithmetic")).toEqual([
      "+ -> -",
      "- -> +",
      "* -> /",
      "/ -> *",
      "% -> *",
    ]);
  });

  it("swaps the compound assignments", () => {
    expect(changes("x += 1; x -= 1; x *= 2; x /= 2; x %= 2;", "arithmetic")).toEqual([
      "+= -> -=",
      "-= -> +=",
      "*= -> /=",
      "/= -> *=",
      "%= -> *=",
    ]);
  });

  it("skips string concatenation, including chains and templates", () => {
    const source = 'const r = ["a" + b, a + "b", `t${x}` + y, `plain` + y, ("a" + b) + c]; s += "x";';
    expect(changes(source, "arithmetic")).toEqual([]);
  });

  it("still mutates numeric addition that feeds a concatenation", () => {
    const mutants = generate('const r = a + b + "c";').filter((m) => m.operator === "arithmetic");
    expect(mutants.map((m) => m.column)).toEqual([13]);
  });

  it("mutates += when neither side is a string", () => {
    expect(changes("s += x;", "arithmetic")).toEqual(["+= -> -="]);
  });
});

describe("MutantGenerator — comparisons and logic", () => {
  it("moves relational boundaries", () => {
    expect(changes("const r = [a < b, a <= b, a > b, a >= b];", "boundary")).toEqual([
      "< -> <=",
      "<= -> <",
      "> -> >=",
      ">= -> >",
    ]);
  });

  it("negates relational and equality operators", () => {
    const source = "const r = [a < b, a <= b, a > b, a >= b, a == b, a != b, a === b, a !== b];";
    expect(changes(source, "negate_conditional")).toEqual([
      "< -> >=",
      "<= -> >",
      "> -> <=",
      ">= -> <",
      "== -> !=",
      "!= -> ==",
      "=== -> !==",
      "!== -> ===",
    ]);
  });

  it("swaps && and || but leaves ?? alone", () => {
    expect(changes("const r = [a && b, a || b, a ?? b];", "logical")).toEqual(["&& -> ||", "|| -> &&"]);
  });
});

describe("MutantGenerator — unary operators and literals", () => {
  it("swaps prefix and postfix increments, spaced or not", () => {
    expect(changes("i++; ++i; i--; --i; i ++;", "increment")).toEqual([
      "++ -> --",
      "++ -> --",
      "-- -> ++",
      "-- -> ++",
      "++ -> --",
    ]);
  });

  it("removes a unary minus and a logical not, but not +, ~ or a non-null assertion", () => {
    const source = "const r = [-x, !y, +z, ~w, v!.p];";
    expect(changes(source, "invert_negative")).toEqual(["- -> "]);
    expect(changes(source, "remove_not")).toEqual(["! -> "]);
  });

  it("replaces a removed token with a space when identifiers would join", () => {
    const source =
      "function f(x: number, y: boolean) { if (y) return!y; if (x) return!(y); if (!x) return-(x); return-x; }\n" +
      "const r = [!y, f(-x), a-!b];";
    const replacements = (operator: string) =>
      generate(source)
        .filter((m) => m.operator === operator)
        .map((m) => m.replacement);
    expect(replacements("remove_not")).toEqual([" ", "", "", "", ""]);
    expect(replacements("invert_negative")).toEqual(["", " ", ""]);
  });

  it("flips boolean literals", () => {
    expect(changes("const r = [true, false];", "boolean_literal")).toEqual(["true -> false", "false -> true"]);
  });

  it("never mutates type positions", () => {
    const source = "let t: true = true; type B = false; type N = -1; const n = -1; class A extends mix(B, true) {}";
    expect(changes(source, "boolean_literal")).toEqual(["true -> false"]);
    expect(changes(source, "invert_negative")).toEqual(["- -> "]);
  });
});

describe("MutantGenerator — remove_call", () => {
  it("replaces call statements in blocks with an empty statement", () => {
    const source = "async function f() { g(); await h(); (k()); obj.m(); }";
    expect(changes(source, "remove_call")).toEqual([
      "g(); -> ;",
      "await h(); -> ;",
      "(k()); -> ;",
      "obj.m(); -> ;",
    ]);
  });

  it("covers top-level, namespace and switch-clause statements, with or without a semicolon", () => {
    const source = "main()\nnamespace N { g(); }\nswitch (x) { case 1: g(); break; default: h(); }";
    expect(changes(source, "remove_call")).toEqual(["main() -> ;", "g(); -> ;", "g(); -> ;", "h(); -> ;"]);
  });

  it("leaves unbraced bodies, non-call statements and skipped callees alone", () => {
    const source = [
      "if (x) g(); else h();",
      "while (x) g();",
      "for (;;) g();",
      "x = g();",
      "new Foo();",
      "console.log(1);",
      'console["warn"](2);',
      'import("./x");',
      "class A extends B { constructor() { super(); } }",
    ].join("\n");
    expect(changes(source, "remove_call")).toEqual([]);
  });
});

describe("MutantGenerator — positions", () => {
  it("records 1-based lines and code-point columns", () => {
    const [mutant] = generate('const s = "😀é"; const r = a < b;').filter((m) => m.operator === "boundary");
    expect(mutant).toMatchObject({ file: "x.ts", line: 1, column: 29, original: "<", replacement: "<=" });
  });

  it("splices the mutant into the source at its offsets", () => {
    const source = "const a = 1;\nconst s = '😀'; const r = a < 2;\n";
    const [mutant] = generate(source).filter((m) => m.operator === "negate_conditional");
    expect(mutant!.line).toBe(2);
    expect(applyMutant(source, mutant!)).toBe("const a = 1;\nconst s = '😀'; const r = a >= 2;\n");
  });

  it("parses TSX and JavaScript sources", () => {
    const tsx = new MutantGenerator().generate(parseSourceFile("const e = <A on={a && b} />;", "x.tsx"), "x.tsx");
    expect(tsx.map((m) => m.operator)).toEqual(["logical"]);
    const js = new MutantGenerator().generate(parseSourceFile("const r = a > 1;", "x.js"), "x.js");
    expect(js.map((m) => m.operator)).toEqual(["boundary", "negate_conditional"]);
  });
});
