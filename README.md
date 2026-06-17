# slopguard-typescript

[![CI](https://github.com/JeevanThandi/slopguard-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/JeevanThandi/slopguard-typescript/actions/workflows/ci.yml)

> **CRAP (Change Risk Anti-Patterns) guardrail for TypeScript / JavaScript.**

> ⚠️ **Alpha (v0.1.x).** The analyzer is stable and self-tested, but the CLI surface and JSON schema may still change before v1.0.

`slopguard-typescript` measures **complex, undertested code** in TypeScript and JavaScript sources. It computes a weighted CRAP score combining cyclomatic and cognitive complexity with line coverage, and prints a structured report you can pipe into `jq` or fail CI on. It is the TypeScript sibling of [slopguard-swift](https://github.com/JeevanThandi/SlopGuard-Swift) — same formula, same schema, same UX.

```
wCRAP(m) = (cyc × cog) × (1 − cov/100)³ + sqrt(cyc × cog)
```

* `cyc` — cyclomatic complexity (McCabe), parsed via the [TypeScript compiler API](https://github.com/microsoft/TypeScript).
* `cog` — cognitive complexity per the [SonarSource 2023 spec](https://www.sonarsource.com/resources/cognitive-complexity/) — penalises nesting, ignores early-exit shapes (`??`, plain `return`), charges a whole `switch` once.
* `wt`  — `sqrt(cyc × cog)`, the geometric blend fed into the formula. A flat 50-case `switch` (cyc=50, cog=1) scores like a small method; a deeply nested 3-branch tangle (cyc=3, cog=12) scores like medium-complex code.
* `cov` — line coverage gathered by slopguard-typescript itself, by driving the project's own test runner. Never user-supplied.
* Default crappy threshold: **30** (on wCRAP).

## Install

```bash
git clone https://github.com/JeevanThandi/slopguard-typescript.git
cd slopguard-typescript
npm install && npm run build
npm link        # exposes `slopguard-ts` on your PATH
```

Requires Node 18.17+.

## Quickstart

```bash
# Zero-config: analyze the current directory (detects vitest/jest, runs it for coverage)
slopguard-ts

# Scan a specific directory and print the top crappy methods
slopguard-ts analyze --path src --threshold 30

# Skip runner auto-detection: tell slopguard which framework to drive
slopguard-ts analyze --path src --runner vitest
slopguard-ts analyze --path src --runner jest

# Monorepo: run the tests of a specific package
slopguard-ts analyze --path packages/core/src --project-dir packages/core

# Full JSON for CI / downstream tooling
slopguard-ts analyze --path src --json | jq '.methods | sort_by(-.crap)[:10]'

# Fail CI when any method's CRAP exceeds 50
slopguard-ts analyze --path src --fail-over 50

# Complexity only (skip the test run — every method shows 0% coverage)
slopguard-ts analyze --path src --no-coverage

# Join coverage CI already produced (or from a runner slopguard can't drive: nyc, c8, mocha)
slopguard-ts analyze --path src --coverage-file coverage/coverage-final.json
```

Progress markers (`slopguard: running vitest with coverage…`) go to **stderr**, so piped stdout stays clean. `--verbose` streams the underlying test-runner output through; `--quiet` silences progress entirely.

## How coverage works

Coverage is an *artifact of the analysis*, not an input — mirroring how slopguard-swift drives `xcodebuild test` itself:

1. **Project discovery.** Walk up from `--path` to the nearest `package.json` (override with `--project-dir`).
2. **Runner detection.** Look for **vitest** or **jest** signals: a config file (`vitest.config.*` / `jest.config.*`), the dependency itself, a `jest` key in package.json, or the runner named in the `test` script. Exactly one match wins; both → `runner_ambiguous` (pass `--runner`); neither → `runner_not_detected` (pass `--runner`, `--coverage-file`, or `--no-coverage`).
3. **Test run.** Spawn the project-local binary (`node_modules/.bin/<runner>`) with flags that force an **istanbul `coverage-final.json`** into a slopguard-owned temp directory — `vitest run --coverage.enabled=true --coverage.reporter=json --coverage.reportsDirectory=…` or `jest --coverage --coverageReporters=json --coverageDirectory=…`. The project's own coverage config is untouched. Failing tests don't abort — partial coverage is still useful (a note is attached). A broken run with no coverage output aborts with the stderr tail.
4. **Join.** Parse the istanbul map into a line index, join per-method line coverage onto the parsed declarations (basename + longest-suffix fallback for CI-vs-local path mismatches), then delete the temp dir.

The istanbul `coverage-final.json` is the universal interchange format — jest, vitest, nyc, and c8 all emit it — so any runner slopguard can't drive directly is still supported via `--coverage-file`.

## Subcommands

| Command   | Purpose |
|-----------|---------|
| `analyze` | Walk a directory of TS/JS sources, drive the test runner for coverage, emit a wCRAP report (text or JSON). |
| `version` | Print version metadata as JSON. |

`analyze` is the default subcommand and `--path` defaults to the current directory — a bare `slopguard-ts` in your project root just works.

## JSON output

`--json` emits a stable, versioned (`schemaVersion: "2"`, shared with slopguard-swift) report with:

* `summary` — file/type/method counts, average + max wCRAP, weighted coverage.
* `methods[]` — every analyzed function/method/constructor/accessor/named-arrow with `complexity`, `cognitiveComplexity`, `weightedComplexity`, `coverage`, `crap`, `isCrappy`, and a stable `id`.
* `types[]` — per-class (and interface/enum/namespace/method-bearing object literal) aggregation: `aggregatedCrap` (formula applied to type totals) and `maxCrap` (worst single-method offender).

Slice with `jq`:

```bash
# Top 10 worst methods
slopguard-ts analyze --path src --json | jq '.methods | sort_by(-.crap)[:10]'

# Only crappy types
slopguard-ts analyze --path src --json | jq '.types[] | select(.isCrappy)'

# Coverage gaps: high complexity, low coverage
slopguard-ts analyze --path src --json \
  | jq '.methods[] | select(.complexity >= 5 and .coverage <= 50)'
```

## Why it exists

Test coverage alone says "this code ran in a test"; complexity alone says "this code has many paths." Neither tells you whether the *risky* code is tested. CRAP combines them: a method with 20 branches and 0% coverage scores 420; the same method at 100% coverage scores 20 (just its complexity). The score lights up the code most likely to break under a refactor *and* be the hardest to verify the fix for.

## What counts as a method

Functions, class methods, constructors, get/set accessors, static blocks, and **named** arrow functions / function expressions (`const handler = () => {}`, object properties, class fields). Anonymous inline callbacks don't get their own entry — their branches count toward the enclosing method, with a cognitive nesting bump for the callback body, per the Sonar spec.

Default excludes keep noise out: `node_modules`, `dist`/`build`/`out`/`coverage`, `*.d.ts`, `*.min.js`, generated code, and test files (`*.test.*`, `*.spec.*`, `__tests__/`, `test(s)/`). Analyze test code itself with `--no-default-excludes`.

## Posture

* **Two top-level runtime dependencies** — `typescript` (Apache-2.0, the official parser) and `commander` (MIT).
* **The only subprocess slopguard-typescript spawns is the project's own test runner**, from the project's own `node_modules/.bin`.
* **No network, no telemetry, no source mutation.** See [`SECURITY.md`](SECURITY.md) for the full threat model and how to report a vulnerability.
* **MIT licensed** ([`LICENSE`](LICENSE)).

## Architecture

```
src/
├── core/             # CRAP formula, models, ComplexityVisitor, DirectoryAnalyzer, formatter
├── coverage/         # runner detection, test runner driver, istanbul CoverageIndex, AnalysisPipeline
└── cli/              # commander entry: analyze / version
```

## Development

```bash
npm install
npm test                                            # builds + unit & integration tests
node dist/cli/main.js analyze --path src            # dogfood
node dist/cli/main.js analyze --path sample-apps/todo-list/src  # known-good fixture
```

We dogfood slopguard-typescript against its own sources *and* against the [`sample-apps/`](sample-apps/) fixtures. The fixtures are deliberately tiny, fully covered, low-complexity packages — running the analyzer against them should always produce the same near-zero CRAP report. Drift against that baseline is a regression signal in the analyzer itself (asserted in `tests/integration.test.ts`).

## Roadmap

* **v0.1** — CLI, full core + coverage (vitest/jest), istanbul interchange. ✅
* **v0.2** — `node --test` + bun runners, SARIF output for GitHub code scanning.
* **v0.3** — Per-PR diff mode (`slopguard-ts diff origin/main…HEAD`).

## Contributing

Issues and pull requests are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). CI keeps the suite green on Node 18.17/20/22, enforces 100% coverage, and asserts the analyzer stays under its own threshold. Changes are tracked in [`CHANGELOG.md`](CHANGELOG.md).
