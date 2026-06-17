import fs from "node:fs";
import path from "node:path";
import { SlopguardError } from "../core/errors.js";

/** Test runners slopguard-typescript can drive itself. */
export type RunnerKind = "vitest" | "jest";

export const SUPPORTED_RUNNERS: readonly RunnerKind[] = ["vitest", "jest"];

const VITEST_CONFIG_FILES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.cts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
  "vitest.workspace.ts",
  "vitest.workspace.js",
];

const JEST_CONFIG_FILES = [
  "jest.config.ts",
  "jest.config.js",
  "jest.config.mjs",
  "jest.config.cjs",
  "jest.config.json",
];

/**
 * Detect which test runner a project uses — the analog of slopguard-swift's
 * xcodebuild scheme discovery. Signals, per runner:
 *
 *   - a dedicated config file (`vitest.config.*` / `jest.config.*`)
 *   - the runner in `dependencies` / `devDependencies`
 *   - a `jest` key in package.json (jest only)
 *   - the runner named in the package.json `test` script
 *
 * Exactly one runner detected → use it. Both → `runner_ambiguous` (pass
 * `--runner` to disambiguate, like `--scheme`). Neither → `runner_not_detected`
 * with the actionable escape hatches.
 */
export function detectRunner(projectRoot: string): RunnerKind {
  const detected = detectCandidates(projectRoot);
  if (detected.length === 1) return detected[0]!;
  if (detected.length > 1) throw SlopguardError.runnerAmbiguous(detected);
  throw SlopguardError.runnerNotDetected(projectRoot);
}

export function detectCandidates(projectRoot: string): RunnerKind[] {
  const pkg = readPackageJson(projectRoot);
  const deps = {
    ...(pkg?.dependencies as Record<string, string> | undefined),
    ...(pkg?.devDependencies as Record<string, string> | undefined),
  };
  const testScript = ((pkg?.scripts as Record<string, string> | undefined)?.test ?? "").toString();

  const detected: RunnerKind[] = [];
  const hasVitest =
    VITEST_CONFIG_FILES.some((f) => fs.existsSync(path.join(projectRoot, f))) ||
    "vitest" in deps ||
    /\bvitest\b/.test(testScript);
  const hasJest =
    JEST_CONFIG_FILES.some((f) => fs.existsSync(path.join(projectRoot, f))) ||
    "jest" in deps ||
    pkg?.jest !== undefined ||
    /\bjest\b/.test(testScript);
  if (hasVitest) detected.push("vitest");
  if (hasJest) detected.push("jest");
  return detected;
}

function readPackageJson(projectRoot: string): Record<string, unknown> | null {
  const pkgPath = path.join(projectRoot, "package.json");
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Locate the runner's executable inside the project's own `node_modules/.bin`.
 * Running the project-local binary (rather than a global install or `npx`)
 * guarantees we execute the version the project pinned, regardless of which
 * package manager installed it.
 */
export function runnerBinary(projectRoot: string, runner: RunnerKind): string {
  const bin = path.join(projectRoot, "node_modules", ".bin", runner);
  if (fs.existsSync(bin)) return bin;
  throw SlopguardError.runnerUnavailable(
    `${runner} is not installed at ${bin} — run your package manager's install first`
  );
}

/**
 * Argument vector that forces the runner to emit an istanbul
 * `coverage-final.json` into `coverageDir`, regardless of the project's own
 * coverage configuration. Kept pure so the plumbing is unit-testable without
 * spawning a subprocess.
 */
export function coverageArguments(runner: RunnerKind, coverageDir: string): string[] {
  switch (runner) {
    case "vitest":
      // `run` disables watch mode. CLI coverage flags override the project's
      // vitest config reporters, so the json reporter is guaranteed.
      return [
        "run",
        "--coverage.enabled=true",
        "--coverage.reporter=json",
        `--coverage.reportsDirectory=${coverageDir}`,
      ];
    case "jest":
      return [
        "--coverage",
        "--coverageReporters=json",
        `--coverageDirectory=${coverageDir}`,
        "--watchAll=false",
      ];
  }
}
