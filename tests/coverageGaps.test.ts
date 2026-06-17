import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SlopguardError } from "../src/core/errors.js";
import { globToRegExp, matchesAny } from "../src/core/analysis/glob.js";
import { discoverProjectRoot } from "../src/coverage/projectRootDiscovery.js";
import { FileAnalyzer, scriptKindFor } from "../src/core/analysis/fileAnalyzer.js";
import { DirectoryAnalyzer, relativize } from "../src/core/analysis/directoryAnalyzer.js";
import { CrapAggregator } from "../src/core/aggregation/crapAggregator.js";
import type { CoverageProvider } from "../src/core/aggregation/coverageProvider.js";
import { prettyReport, jsonReport } from "../src/core/formatting/crapReportFormatter.js";
import { AnalysisPipeline, expandTilde } from "../src/coverage/analysisPipeline.js";
import { CoverageIndex } from "../src/coverage/coverageIndex.js";
import { parseIstanbulJson } from "../src/coverage/istanbul.js";
import type { IstanbulFileCoverage } from "../src/coverage/istanbul.js";

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), "..");

describe("SlopguardError factory tails", () => {
  it("builds parse_failed and coverage_decode_failed", () => {
    expect(SlopguardError.parseFailed("a.ts", "boom").code).toBe("parse_failed");
    expect(SlopguardError.parseFailed("a.ts", "boom").message).toContain("a.ts");
    expect(SlopguardError.coverageDecodeFailed("bad json").code).toBe("coverage_decode_failed");
  });
});

describe("globToRegExp edge cases", () => {
  it("escapes an unclosed character class literally", () => {
    expect(globToRegExp("a[b").test("a[b")).toBe(true);
    expect(matchesAny(["a[b"], "a[b")).toBe(true);
  });
});

describe("discoverProjectRoot", () => {
  it("climbs from a file path to the nearest package.json", () => {
    expect(discoverProjectRoot(thisFile)).toBe(repoRoot);
  });

  it("treats a non-existent path as a file and climbs from its parent", () => {
    expect(discoverProjectRoot(path.join(repoRoot, "no-such-dir", "ghost"))).toBe(repoRoot);
  });

  it("returns the start directory as a fallback when no marker exists", () => {
    expect(discoverProjectRoot("/")).toBe("/");
  });
});

describe("FileAnalyzer", () => {
  it("throws unreadable_file for a missing file", async () => {
    await expect(
      new FileAnalyzer().analyzeFile(path.join(repoRoot, "definitely-missing.ts"))
    ).rejects.toMatchObject({ code: "unreadable_file" });
  });

  it("reads a file and defaults the reported path to the real path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "slopguard-fa-"));
    const file = path.join(dir, "m.ts");
    await writeFile(file, "export function m() { return 1; }\n");
    try {
      const report = await new FileAnalyzer().analyzeFile(file); // no reportedPath
      expect(report.path).toBe(file);
      expect(report.methods.map((m) => m.qualifiedName)).toContain("m");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the TS script kind for an extensionless reported path", () => {
    const report = new FileAnalyzer().analyzeSource("export function k() { return 1; }", "Makefile");
    expect(report.methods.map((m) => m.qualifiedName)).toContain("k");
  });
});

describe("scriptKindFor", () => {
  it("returns null for a path with no extension", () => {
    expect(scriptKindFor("README")).toBeNull();
  });
});

describe("relativize", () => {
  it("returns the basename when absolute equals root", () => {
    expect(relativize("/a/b", "/a/b")).toBe("b");
  });
  it("handles a root that already ends with a separator", () => {
    expect(relativize(`${path.sep}a${path.sep}b${path.sep}c.ts`, `${path.sep}a${path.sep}b${path.sep}`)).toBe("c.ts");
  });
  it("returns the path unchanged when it is not under root", () => {
    expect(relativize("/x/y.ts", "/a/b")).toBe("/x/y.ts".split(path.sep).join("/"));
  });
});

describe("DirectoryAnalyzer file-set resolution", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "slopguard-dir-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("analyzes a single file path directly", async () => {
    const file = path.join(root, "solo.ts");
    await writeFile(file, "export const x = 1;\n");
    const reports = await new DirectoryAnalyzer().analyze(file);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.path).toBe("solo.ts");
  });

  it("throws unreadable_file when a subdirectory cannot be read", async () => {
    const locked = path.join(root, "locked");
    await mkdir(locked);
    await writeFile(path.join(root, "ok.ts"), "export const y = 2;\n");
    await chmod(locked, 0o000);
    try {
      await expect(new DirectoryAnalyzer().analyze(root)).rejects.toMatchObject({ code: "unreadable_file" });
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it("sorts multiple files, skips hidden entries, and ignores non-file entries", async () => {
    await writeFile(path.join(root, "b.ts"), "export const b = 1;\n");
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(root, ".hidden.ts"), "export const h = 1;\n");
    await mkdir(path.join(root, ".hiddendir"));
    const target = path.join(root, "a.ts");
    await symlink(target, path.join(root, "link.ts")); // symlink → not a regular file
    const reports = await new DirectoryAnalyzer().analyze(root);
    expect(reports.map((r) => r.path)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("CrapAggregator edge cases", () => {
  const agg = new CrapAggregator();

  it("returns zeroed summary fields for an empty report with coverage available", () => {
    const provider: CoverageProvider = { methodCoverage: () => null, fileCoverage: () => null };
    const report = agg.aggregate({
      fileReports: [],
      sourceRoot: "/root",
      coverageDataPath: null,
      coverage: provider,
    });
    expect(report.summary.methodCount).toBe(0);
    expect(report.summary.averageCrap).toBe(0);
    expect(report.summary.maxCrap).toBe(0);
    expect(report.summary.averageComplexity).toBe(0);
    // coverage available but nothing executable → 0, not null.
    expect(report.summary.weightedCoverage).toBe(0);
  });

  it("falls back to file-level coverage and accepts absolute method paths", () => {
    const fileReport = new FileAnalyzer().analyzeSource(
      `export function f(x: number) { if (x > 0) { return 1; } return 0; }`,
      "/abs/file.ts"
    );
    const provider: CoverageProvider = { methodCoverage: () => null, fileCoverage: () => 50 };
    const report = agg.aggregate({
      fileReports: [fileReport],
      sourceRoot: "/root",
      coverageDataPath: null,
      coverage: provider,
    });
    expect(report.methods[0]!.coverage).toBe(50);
    expect(report.coverageAvailable).toBe(true);
  });
});

describe("prettyReport rendering branches", () => {
  const base = new FileAnalyzer().analyzeSource(`export function f() { return 1; }`, "f.ts");
  const agg = new CrapAggregator();

  it("prints a concrete coverage path when one is recorded", () => {
    const report = agg.aggregate({
      fileReports: [base],
      sourceRoot: "/root",
      coverageDataPath: "/tmp/coverage-final.json",
      coverage: { methodCoverage: () => 100, fileCoverage: () => 100 },
    });
    expect(prettyReport(report)).toContain("/tmp/coverage-final.json");
  });

  it("prints the empty-set message when there are no methods", () => {
    const report = agg.aggregate({
      fileReports: [],
      sourceRoot: "/root",
      coverageDataPath: null,
      coverage: null,
    });
    expect(prettyReport(report)).toContain("No methods analyzed.");
  });

  it("emits compact JSON when pretty-printing is disabled", () => {
    const report = agg.aggregate({
      fileReports: [base],
      sourceRoot: "/root",
      coverageDataPath: null,
      coverage: null,
    });
    const compact = jsonReport(report, false);
    expect(compact).not.toContain("\n");
    expect(JSON.parse(compact).schemaVersion).toBe("2");
  });
});

describe("expandTilde", () => {
  it("expands a bare ~ and a ~/ prefix to the home directory", () => {
    expect(expandTilde("~")).toBe(os.homedir());
    expect(expandTilde("~/sub")).toBe(path.join(os.homedir(), "/sub"));
  });
  it("leaves other paths untouched", () => {
    expect(expandTilde("/abs/path")).toBe("/abs/path");
  });
});

describe("AnalysisPipeline coverage decode failure", () => {
  it("maps malformed prebuilt coverage to coverage_decode_failed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "slopguard-decode-"));
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
    const covPath = path.join(dir, "coverage-final.json");
    await writeFile(covPath, "this is not json");
    try {
      await expect(
        new AnalysisPipeline().run({
          sourcePath: path.join(dir, "src"),
          coverage: { mode: "prebuilt", coverageFile: covPath },
        })
      ).rejects.toMatchObject({ code: "coverage_decode_failed" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function fileCov(over: Partial<IstanbulFileCoverage> & { path: string }): IstanbulFileCoverage {
  return { statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {}, ...over };
}

describe("CoverageIndex lookup", () => {
  it("falls back to a unique basename match across different absolute paths", () => {
    const index = new CoverageIndex({
      "/ci/runner/work/src/a.ts": fileCov({
        path: "/ci/runner/work/src/a.ts",
        statementMap: { "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } } },
        s: { "0": 1 },
      }),
    });
    expect(index.fileCoverage("/local/dev/src/a.ts")).toBe(100);
  });

  it("disambiguates duplicate basenames by longest shared suffix", () => {
    const index = new CoverageIndex({
      "/p/one/util.ts": fileCov({
        path: "/p/one/util.ts",
        statementMap: { "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } } },
        s: { "0": 0 },
      }),
      "/p/two/util.ts": fileCov({
        path: "/p/two/util.ts",
        statementMap: { "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } } },
        s: { "0": 1 },
      }),
    });
    // The query shares a longer suffix with /p/two/util.ts.
    expect(index.fileCoverage("/elsewhere/two/util.ts")).toBe(100);
  });

  it("treats a missing statement hit count as uncovered", () => {
    const index = new CoverageIndex({
      "/x/m.ts": fileCov({
        path: "/x/m.ts",
        statementMap: { "0": { start: { line: 3, column: 0 }, end: { line: 3, column: 5 } } },
        s: {}, // id 0 absent → defaults to 0 hits
      }),
    });
    expect(index.methodCoverage("/x/m.ts", 3, 3)).toBe(0);
  });

  it("returns null for an unknown file and for a file with no executable lines", () => {
    const index = new CoverageIndex({
      "/x/empty.ts": fileCov({ path: "/x/empty.ts" }),
    });
    expect(index.methodCoverage("/x/unknown.ts", 1, 9)).toBeNull();
    expect(index.fileCoverage("/x/empty.ts")).toBeNull();
  });
});

describe("parseIstanbulJson", () => {
  it("unwraps the nested data envelope and skips non-coverage entries", () => {
    const map = parseIstanbulJson(
      JSON.stringify({
        "/x/a.ts": { data: { path: "/x/a.ts", statementMap: {}, s: {} } },
        "/x/skip.ts": null,
        meta: 42,
        "/x/notcov.ts": { path: 123 },
      })
    );
    expect(Object.keys(map)).toEqual(["/x/a.ts"]);
    expect(map["/x/a.ts"]!.path).toBe("/x/a.ts");
  });
});
