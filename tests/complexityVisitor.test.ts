import { describe, expect, it } from "vitest";
import { FileAnalyzer } from "../src/core/analysis/fileAnalyzer.js";
import { FileReport } from "../src/core/models.js";

const analyzer = new FileAnalyzer();

function analyze(source: string, path = "test.ts"): FileReport {
  return analyzer.analyzeSource(source, path);
}

function method(source: string, qualifiedName: string) {
  const report = analyze(source);
  const m = report.methods.find((m) => m.qualifiedName === qualifiedName);
  if (!m) {
    throw new Error(
      `Method ${qualifiedName} not found in: ${report.methods.map((m) => m.qualifiedName).join(", ")}`
    );
  }
  return m;
}

const cyc = (source: string, name: string) => method(source, name).complexity;
const cog = (source: string, name: string) => method(source, name).cognitiveComplexity;

describe("cyclomatic complexity", () => {
  it("is 1 for a straight-line function", () => {
    expect(cyc(`function foo() { const x = 1; return x + 1; }`, "foo")).toBe(1);
  });

  it("counts each if in a chain", () => {
    const src = `
      function foo(x: number): number {
        if (x > 0) { return 1; }
        else if (x < 0) { return -1; }
        else { return 0; }
      }`;
    expect(cyc(src, "foo")).toBe(3);
  });

  it("counts loops", () => {
    const src = `
      function foo(xs: number[]) {
        for (let i = 0; i < 10; i++) {}
        for (const x of xs) {}
        for (const k in xs) {}
        while (true) {}
        do {} while (false);
      }`;
    expect(cyc(src, "foo")).toBe(6);
  });

  it("counts switch cases but not default", () => {
    const src = `
      function foo(x: number): string {
        switch (x) {
          case 0: return "z";
          case 1: return "o";
          case 2: return "t";
          default: return "?";
        }
      }`;
    expect(cyc(src, "foo")).toBe(4);
  });

  it("counts catch clauses", () => {
    const src = `
      function foo() {
        try { maybe(); } catch (e) { return; } finally {}
      }`;
    expect(cyc(src, "foo")).toBe(2);
  });

  it("counts logical operators", () => {
    expect(cyc(`function foo(a: boolean, b: boolean, c: boolean) { return a && b || c; }`, "foo")).toBe(3);
  });

  it("counts nullish coalescing", () => {
    expect(cyc(`function foo(a?: number) { return a ?? 0; }`, "foo")).toBe(2);
  });

  it("counts ternaries", () => {
    expect(cyc(`function foo(a: boolean) { return a ? 1 : 0; }`, "foo")).toBe(2);
  });

  it("counts compound boolean assignments", () => {
    const src = `function foo(a: boolean, b: number | null) { a &&= check(); b ??= 1; return [a, b]; }`;
    expect(cyc(src, "foo")).toBe(3);
  });

  it("does not count optional chaining", () => {
    expect(cyc(`function foo(a?: { b: () => void }) { a?.b(); }`, "foo")).toBe(1);
  });
});

describe("cognitive complexity (SonarSource 2023)", () => {
  it("is 0 for a straight-line function", () => {
    expect(cog(`function foo() { return 1; }`, "foo")).toBe(0);
  });

  it("scores a flat if at 1", () => {
    expect(cog(`function foo(a: boolean) { if (a) { return 1; } return 0; }`, "foo")).toBe(1);
  });

  it("scores else-if chains as hybrid +1 each", () => {
    const src = `
      function foo(x: number): number {
        if (x > 0) { return 1; }       // +1 structural
        else if (x < 0) { return -1; } // +1 hybrid
        else { return 0; }             // +1 hybrid
      }`;
    expect(cog(src, "foo")).toBe(3);
  });

  it("amplifies nesting", () => {
    const src = `
      function foo(a: boolean, b: boolean, c: boolean) {
        if (a) {              // +1 (nesting 0)
          if (b) {            // +2 (nesting 1)
            if (c) {          // +3 (nesting 2)
              return 1;
            }
          }
        }
        return 0;
      }`;
    expect(cog(src, "foo")).toBe(6);
  });

  it("scores a whole switch as one structural increment", () => {
    const src = `
      function foo(x: number): string {
        switch (x) {                // +1 — flat dispatch, regardless of case count
          case 0: return "a";
          case 1: return "b";
          case 2: return "c";
          case 3: return "d";
          default: return "?";
        }
      }`;
    expect(cog(src, "foo")).toBe(1);
  });

  it("collapses runs of like boolean operators", () => {
    // One run of &&: +1
    expect(cog(`function foo(a: boolean, b: boolean, c: boolean) { return a && b && c; }`, "foo")).toBe(1);
    // a && b || c && d: three runs
    expect(
      cog(
        `function foo(a: boolean, b: boolean, c: boolean, d: boolean) { return a && b || c && d; }`,
        "foo"
      )
    ).toBe(3);
  });

  it("counts parenthesized groups as separate runs", () => {
    expect(
      cog(`function foo(a: boolean, b: boolean, c: boolean) { return (a && b) && c; }`, "foo")
    ).toBe(2);
  });

  it("ignores nullish coalescing", () => {
    expect(cog(`function foo(a?: number) { return a ?? 0; }`, "foo")).toBe(0);
  });

  it("does not charge for anonymous callbacks but bumps their nesting", () => {
    const src = `
      function foo(xs: number[]) {
        return xs.map((x) => {   // +0 hybrid, nesting +1
          if (x > 0) {           // +2 (nesting 1)
            return x;
          }
          return -x;
        });
      }`;
    expect(cog(src, "foo")).toBe(2);
  });

  it("counts loops structurally with nesting", () => {
    const src = `
      function foo(xs: number[][]) {
        for (const row of xs) {     // +1
          for (const cell of row) { // +2
            if (cell > 0) {}        // +3
          }
        }
      }`;
    expect(cog(src, "foo")).toBe(6);
  });

  it("counts labeled jumps", () => {
    const src = `
      function foo(xs: number[][]) {
        outer: for (const row of xs) {  // +1
          for (const cell of row) {     // +2
            if (cell > 0) {             // +3
              continue outer;           // +1 labeled jump
            }
          }
        }
      }`;
    expect(cog(src, "foo")).toBe(7);
  });

  it("scores ternaries structurally", () => {
    expect(cog(`function foo(a: boolean) { return a ? 1 : 0; }`, "foo")).toBe(1);
  });
});

describe("declaration discovery and naming", () => {
  it("qualifies methods by the enclosing type chain", () => {
    const src = `
      class Outer {
        method() {}
      }
      namespace Wrapper {
        export class Inner {
          bar(label: number) { if (label > 0) {} }
        }
      }`;
    const m = method(src, "Wrapper.Inner.bar");
    expect(m.typeName).toBe("Inner");
    expect(m.complexity).toBe(2);
  });

  it("aggregates per-type totals", () => {
    const src = `
      class Outer {
        a(x: boolean) { if (x) {} }
        b(x: boolean) { return x ? 1 : 0; }
      }`;
    const report = analyze(src);
    const outer = report.types.find((t) => t.name === "Outer")!;
    expect(outer.methodCount).toBe(2);
    expect(outer.totalComplexity).toBe(4);
    expect(outer.maxComplexity).toBe(2);
    expect(outer.kind).toBe("class");
  });

  it("treats named arrow functions as methods", () => {
    const src = `const handler = (x: number) => { if (x > 0) { return x; } return 0; };`;
    const m = method(src, "handler");
    expect(m.kind).toBe("arrow");
    expect(m.complexity).toBe(2);
    expect(m.cognitiveComplexity).toBe(1);
  });

  it("treats class fields holding arrows as methods of the class", () => {
    const src = `
      class Widget {
        onClick = (e: unknown) => { if (e) {} };
      }`;
    const m = method(src, "Widget.onClick");
    expect(m.typeName).toBe("Widget");
    expect(m.complexity).toBe(2);
  });

  it("names constructors and accessors", () => {
    const src = `
      class Box {
        #v = 0;
        constructor(v: number) { this.#v = v; }
        get value(): number { return this.#v; }
        set value(v: number) { this.#v = v; }
      }`;
    expect(method(src, "Box.constructor").kind).toBe("constructor");
    expect(method(src, "Box.value.get").kind).toBe("getter");
    expect(method(src, "Box.value.set").kind).toBe("setter");
  });

  it("treats method-bearing object literals as types", () => {
    const src = `
      const api = {
        fetchOne(id: number) { if (id < 0) { throw new Error("bad"); } return id; },
        fetchAll: () => [],
      };`;
    const report = analyze(src);
    const api = report.types.find((t) => t.name === "api")!;
    expect(api.kind).toBe("object");
    expect(api.methodCount).toBe(2);
    expect(method(src, "api.fetchOne").complexity).toBe(2);
  });

  it("does not turn plain config object literals into types", () => {
    const report = analyze(`const config = { port: 8080, host: "localhost" };`);
    expect(report.types).toHaveLength(0);
  });

  it("counts anonymous callbacks toward the enclosing method", () => {
    const src = `
      function foo(xs: number[]) {
        return xs.filter((x) => x > 0 && x < 10);
      }`;
    const report = analyze(src);
    expect(report.methods).toHaveLength(1);
    expect(report.methods[0]!.complexity).toBe(2); // base + &&
  });

  it("gives named nested functions their own frame", () => {
    const src = `
      function outer() {
        function inner(x: boolean) { if (x) {} }
        inner(true);
      }`;
    expect(cyc(src, "outer")).toBe(1);
    expect(cyc(src, "inner")).toBe(2);
  });

  it("records 1-based line ranges", () => {
    const src = `function foo() {\n  return 1;\n}`;
    const m = method(src, "foo");
    expect(m.startLine).toBe(1);
    expect(m.endLine).toBe(3);
  });

  it("computes weightedComplexity as the geometric mean", () => {
    const src = `
      function foo(a: boolean, b: boolean) {
        if (a) { if (b) { return 1; } }
        return 0;
      }`;
    const m = method(src, "foo");
    expect(m.weightedComplexity).toBeCloseTo(Math.sqrt(m.complexity * m.cognitiveComplexity));
  });

  it("parses tsx", () => {
    const src = `
      export function App({ items }: { items: string[] }) {
        return <ul>{items.map((i) => (<li key={i}>{i}</li>))}</ul>;
      }`;
    const report = analyzer.analyzeSource(src, "app.tsx");
    expect(report.methods.map((m) => m.qualifiedName)).toContain("App");
  });
});
