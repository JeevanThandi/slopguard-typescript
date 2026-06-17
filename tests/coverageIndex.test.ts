import { describe, expect, it } from "vitest";
import { CoverageIndex } from "../src/coverage/coverageIndex.js";
import { parseIstanbulJson } from "../src/coverage/istanbul.js";

function range(startLine: number, endLine = startLine) {
  return { start: { line: startLine, column: 0 }, end: { line: endLine, column: 10 } };
}

const fixture = {
  "/proj/src/store.ts": {
    path: "/proj/src/store.ts",
    statementMap: {
      "0": range(2),
      "1": range(3),
      "2": range(7),
      "3": range(8),
      "4": range(9),
    },
    fnMap: {
      "0": { name: "covered", decl: range(1), loc: range(1, 4) },
      "1": { name: "uncovered", decl: range(6), loc: range(6, 10) },
    },
    branchMap: {},
    s: { "0": 3, "1": 3, "2": 0, "3": 0, "4": 0 },
    f: { "0": 3, "1": 0 },
    b: {},
  },
};

describe("parseIstanbulJson", () => {
  it("parses a plain coverage map", () => {
    const map = parseIstanbulJson(JSON.stringify(fixture));
    expect(Object.keys(map)).toEqual(["/proj/src/store.ts"]);
    expect(map["/proj/src/store.ts"]!.path).toBe("/proj/src/store.ts");
  });

  it("unwraps the nested data envelope some istanbul versions emit", () => {
    const wrapped = { "/proj/src/store.ts": { data: fixture["/proj/src/store.ts"] } };
    const map = parseIstanbulJson(JSON.stringify(wrapped));
    expect(map["/proj/src/store.ts"]!.statementMap).toBeDefined();
  });

  it("skips entries that are not file coverage", () => {
    const map = parseIstanbulJson(JSON.stringify({ junk: { foo: 1 } }));
    expect(Object.keys(map)).toHaveLength(0);
  });
});

describe("CoverageIndex", () => {
  const index = new CoverageIndex(parseIstanbulJson(JSON.stringify(fixture)));

  it("computes method coverage from statements in the line range", () => {
    expect(index.methodCoverage("/proj/src/store.ts", 1, 4)).toBe(100);
    expect(index.methodCoverage("/proj/src/store.ts", 6, 10)).toBe(0);
  });

  it("returns null when no executable line falls in the range", () => {
    expect(index.methodCoverage("/proj/src/store.ts", 20, 30)).toBeNull();
  });

  it("returns null for unknown files", () => {
    expect(index.methodCoverage("/elsewhere/other.ts", 1, 10)).toBeNull();
    expect(index.fileCoverage("/elsewhere/other.ts")).toBeNull();
  });

  it("computes file coverage across all statements", () => {
    expect(index.fileCoverage("/proj/src/store.ts")).toBeCloseTo(40); // 2 of 5 lines
  });

  it("falls back to basename matching when absolute paths differ", () => {
    // CI checkout vs local clone: same file, different prefix.
    expect(index.fileCoverage("/home/runner/work/src/store.ts")).toBeCloseTo(40);
  });

  it("uses longest shared suffix to disambiguate duplicate basenames", () => {
    const dup = {
      "/proj/a/util.ts": {
        path: "/proj/a/util.ts",
        statementMap: { "0": range(1) },
        fnMap: {},
        branchMap: {},
        s: { "0": 1 },
        f: {},
        b: {},
      },
      "/proj/b/util.ts": {
        path: "/proj/b/util.ts",
        statementMap: { "0": range(1) },
        fnMap: {},
        branchMap: {},
        s: { "0": 0 },
        f: {},
        b: {},
      },
    };
    const idx = new CoverageIndex(parseIstanbulJson(JSON.stringify(dup)));
    expect(idx.fileCoverage("/elsewhere/b/util.ts")).toBe(0);
    expect(idx.fileCoverage("/elsewhere/a/util.ts")).toBe(100);
  });

  it("counts totals", () => {
    expect(index.totalExecutableLines).toBe(5);
    expect(index.totalCoveredLines).toBe(2);
    expect(index.fileCount).toBe(1);
  });
});
