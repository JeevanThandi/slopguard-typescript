import { describe, expect, it } from "vitest";
import { FileAnalyzer } from "../src/core/analysis/fileAnalyzer.js";
import { FileReport } from "../src/core/models.js";

const analyzer = new FileAnalyzer();
const analyze = (source: string, p = "test.ts"): FileReport => analyzer.analyzeSource(source, p);
const find = (source: string, name: string) => {
  const r = analyze(source);
  const m = r.methods.find((m) => m.qualifiedName === name);
  if (!m) throw new Error(`no method ${name} in ${r.methods.map((m) => m.qualifiedName).join(", ")}`);
  return m;
};

describe("exotic grammar dispatch", () => {
  it("counts ?? cyclomatically but not cognitively", () => {
    const m = find(`function f(a: string | null) { return a ?? "x"; }`, "f");
    expect(m.complexity).toBe(2);
    expect(m.cognitiveComplexity).toBe(0);
  });

  it("counts &&= and ||= as boolean branches with a cognitive bump", () => {
    const m = find(`function f(o: { a: boolean; b: boolean }) { o.a &&= true; o.b ||= false; }`, "f");
    expect(m.complexity).toBe(3); // base + &&= + ||=
    expect(m.cognitiveComplexity).toBe(2);
  });

  it("counts ??= cyclomatically only", () => {
    const m = find(`function f(o: { a: number | null }) { o.a ??= 1; }`, "f");
    expect(m.complexity).toBe(2);
    expect(m.cognitiveComplexity).toBe(0);
  });

  it("charges a labeled jump but not a plain one", () => {
    const labeled = find(
      `function f() { outer: for (;;) { for (;;) { break outer; } } }`,
      "f"
    );
    const plain = find(`function g() { for (;;) { break; } }`, "g");
    expect(labeled.cognitiveComplexity).toBeGreaterThan(plain.cognitiveComplexity);
  });

  it("treats namespaces, enums, and interfaces as type containers", () => {
    const report = analyze(`
      export namespace N { export function inside() { return 1; } }
      export enum E { A, B }
      export interface I { x: number }
    `);
    const kinds = report.types.map((t) => t.kind).sort();
    expect(kinds).toContain("namespace");
    expect(kinds).toContain("enum");
    expect(kinds).toContain("interface");
  });

  it("frames getters, setters, and static blocks as methods", () => {
    const report = analyze(`
      class C {
        static { C.flag = true; }
        get value() { return this._v; }
        set value(v: number) { this._v = v; }
        _v = 0;
        static flag = false;
      }
    `);
    const names = report.methods.map((m) => m.qualifiedName);
    expect(names).toContain("C.value.get");
    expect(names).toContain("C.value.set");
    expect(names).toContain("C.static");
  });

  it("names function expressions bound to variables and properties", () => {
    const report = analyze(`
      const fn = function () { return 1; };
      const obj = { handler: function () { return 2; } };
    `);
    const names = report.methods.map((m) => m.qualifiedName);
    expect(names).toContain("fn");
    expect(names).toContain("obj.handler");
  });

  it("labels an anonymous default-exported class as <anonymous>", () => {
    const report = analyze(`export default class { method() { return 1; } }`);
    expect(report.types.some((t) => t.name === "<anonymous>")).toBe(true);
  });

  it("treats a method-bearing object literal as a type but a plain one as not", () => {
    const withMethod = analyze(`const a = { run() { return 1; } };`);
    expect(withMethod.types.some((t) => t.kind === "object" && t.name === "a")).toBe(true);
    const plain = analyze(`const b = { x: 1, y: 2 };`);
    expect(plain.types.some((t) => t.kind === "object")).toBe(false);
  });

  it("labels an anonymous default-exported function as <anonymous>", () => {
    const report = analyze(`export default function () { return 1; }`);
    expect(report.methods.some((m) => m.qualifiedName === "<anonymous>")).toBe(true);
  });

  it("keeps a string-literal method name verbatim", () => {
    const report = analyze(`class C { "odd-name"() { return 1; } }`);
    expect(report.methods.some((m) => m.qualifiedName === "C.odd-name")).toBe(true);
  });

  it("resolves a computed property name via getText", () => {
    const report = analyze(`class C { ["a" + "b"]() { return 1; } }`);
    expect(report.methods.some((m) => m.typeName === "C")).toBe(true);
  });

  it("does not treat an object literal of shorthand properties as a type", () => {
    const report = analyze(`const x = 1; const a = { x };`);
    expect(report.types.some((t) => t.kind === "object")).toBe(false);
  });

  it("scores a ternary as a structural branch", () => {
    const m = find(`function f(x: number) { return x > 0 ? 1 : -1; }`, "f");
    expect(m.complexity).toBe(2);
    expect(m.cognitiveComplexity).toBe(1);
  });
});
