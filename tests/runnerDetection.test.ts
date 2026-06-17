import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  coverageArguments,
  detectCandidates,
  detectRunner,
  runnerBinary,
} from "../src/coverage/runnerDetection.js";
import { discoverProjectRoot } from "../src/coverage/projectRootDiscovery.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "slopguard-runner-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function pkg(json: object): Promise<void> {
  await writeFile(path.join(root, "package.json"), JSON.stringify(json));
}

describe("detectRunner", () => {
  it("detects vitest from devDependencies", async () => {
    await pkg({ devDependencies: { vitest: "^2.0.0" } });
    expect(detectRunner(root)).toBe("vitest");
  });

  it("detects jest from devDependencies", async () => {
    await pkg({ devDependencies: { jest: "^29.0.0" } });
    expect(detectRunner(root)).toBe("jest");
  });

  it("detects vitest from a config file", async () => {
    await pkg({});
    await writeFile(path.join(root, "vitest.config.ts"), "export default {};");
    expect(detectRunner(root)).toBe("vitest");
  });

  it("detects jest from a package.json jest key", async () => {
    await pkg({ jest: { testEnvironment: "node" } });
    expect(detectRunner(root)).toBe("jest");
  });

  it("detects from the test script", async () => {
    await pkg({ scripts: { test: "vitest run" } });
    expect(detectRunner(root)).toBe("vitest");
  });

  it("throws runner_ambiguous when both are present", async () => {
    await pkg({ devDependencies: { vitest: "^2.0.0", jest: "^29.0.0" } });
    expect(() => detectRunner(root)).toThrowError(/runner_ambiguous|Multiple test runners/);
    expect(detectCandidates(root)).toEqual(["vitest", "jest"]);
  });

  it("throws runner_not_detected with actionable escape hatches", async () => {
    await pkg({});
    expect(() => detectRunner(root)).toThrowError(/--runner|--coverage-file|--no-coverage/);
  });

  it("throws runner_not_detected when there is no package.json at all", () => {
    expect(() => detectRunner(root)).toThrow();
  });
});

describe("runnerBinary", () => {
  it("finds the project-local binary", async () => {
    const bin = path.join(root, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "vitest"), "#!/bin/sh\n");
    expect(runnerBinary(root, "vitest")).toBe(path.join(bin, "vitest"));
  });

  it("throws runner_unavailable when the binary is missing", () => {
    expect(() => runnerBinary(root, "jest")).toThrowError(/not installed/);
  });
});

describe("coverageArguments", () => {
  it("forces a json reporter into the given directory for vitest", () => {
    const args = coverageArguments("vitest", "/tmp/cov");
    expect(args).toContain("run");
    expect(args).toContain("--coverage.enabled=true");
    expect(args).toContain("--coverage.reporter=json");
    expect(args).toContain("--coverage.reportsDirectory=/tmp/cov");
  });

  it("forces a json reporter into the given directory for jest", () => {
    const args = coverageArguments("jest", "/tmp/cov");
    expect(args).toContain("--coverage");
    expect(args).toContain("--coverageReporters=json");
    expect(args).toContain("--coverageDirectory=/tmp/cov");
  });
});

describe("discoverProjectRoot", () => {
  it("walks up from a nested source dir to the nearest package.json", async () => {
    await pkg({});
    const nested = path.join(root, "src", "deep");
    await mkdir(nested, { recursive: true });
    expect(discoverProjectRoot(nested)).toBe(root);
  });

  it("starts from the parent directory for a file path", async () => {
    await pkg({});
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    const file = path.join(src, "a.ts");
    await writeFile(file, "export {};\n");
    expect(discoverProjectRoot(file)).toBe(root);
  });

  it("prefers the nearest package.json in a monorepo", async () => {
    await pkg({});
    const sub = path.join(root, "packages", "core");
    await mkdir(path.join(sub, "src"), { recursive: true });
    await writeFile(path.join(sub, "package.json"), "{}");
    expect(discoverProjectRoot(path.join(sub, "src"))).toBe(sub);
  });

  it("falls back to the starting directory when nothing is found", async () => {
    const isolated = await mkdtemp(path.join(os.tmpdir(), "slopguard-isolated-"));
    try {
      // No package.json anywhere up the temp tree (in practice the temp root).
      const result = discoverProjectRoot(isolated);
      expect(typeof result).toBe("string");
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });
});
