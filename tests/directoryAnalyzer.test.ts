import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defaultAnalysisOptions,
  DirectoryAnalyzer,
} from "../src/core/analysis/directoryAnalyzer.js";
import { SlopguardError } from "../src/core/errors.js";

let root: string;
const analyzer = new DirectoryAnalyzer();

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "slopguard-test-"));
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
  await mkdir(path.join(root, "__tests__"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export function a() { return 1; }\n");
  await writeFile(path.join(root, "src", "nested", "b.tsx"), "export const b = () => 2;\n");
  await writeFile(path.join(root, "src", "c.test.ts"), "export function testHelper() {}\n");
  await writeFile(path.join(root, "src", "types.d.ts"), "export declare function x(): void;\n");
  await writeFile(path.join(root, "node_modules", "dep", "index.js"), "module.exports = () => 1;\n");
  await writeFile(path.join(root, "__tests__", "d.ts"), "export function d() {}\n");
  await writeFile(path.join(root, "README.md"), "# not source\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("DirectoryAnalyzer", () => {
  it("finds analyzable sources and reports root-relative forward-slash paths", async () => {
    const reports = await analyzer.analyze(root);
    expect(reports.map((r) => r.path)).toEqual(["src/a.ts", "src/nested/b.tsx"]);
  });

  it("applies default excludes (node_modules, tests, d.ts)", async () => {
    const reports = await analyzer.analyze(root);
    const paths = reports.map((r) => r.path);
    expect(paths).not.toContain("node_modules/dep/index.js");
    expect(paths).not.toContain("src/c.test.ts");
    expect(paths).not.toContain("src/types.d.ts");
    expect(paths).not.toContain("__tests__/d.ts");
  });

  it("honors include globs", async () => {
    const options = { ...defaultAnalysisOptions(), includeGlobs: ["**/*.tsx"] };
    const reports = await analyzer.analyze(root, options);
    expect(reports.map((r) => r.path)).toEqual(["src/nested/b.tsx"]);
  });

  it("honors extra exclude globs", async () => {
    const options = defaultAnalysisOptions();
    options.excludeGlobs.push("**/nested/**");
    const reports = await analyzer.analyze(root, options);
    expect(reports.map((r) => r.path)).toEqual(["src/a.ts"]);
  });

  it("analyzes test files when default excludes are off", async () => {
    const options = { includeGlobs: [], excludeGlobs: ["**/node_modules/**"] };
    const reports = await analyzer.analyze(root, options);
    expect(reports.map((r) => r.path)).toContain("src/c.test.ts");
  });

  it("analyzes a single file with a basename path", async () => {
    const reports = await analyzer.analyze(path.join(root, "src", "a.ts"));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.path).toBe("a.ts");
    expect(reports[0]!.methods.map((m) => m.name)).toEqual(["a"]);
  });

  it("throws file_not_found for a missing path", async () => {
    await expect(analyzer.analyze(path.join(root, "missing"))).rejects.toMatchObject({
      code: "file_not_found",
    });
    await expect(analyzer.analyze(path.join(root, "missing"))).rejects.toBeInstanceOf(SlopguardError);
  });
});
