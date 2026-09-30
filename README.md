# slopguard-typescript

[![CI](https://github.com/JeevanThandi/slopguard-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/JeevanThandi/slopguard-typescript/actions/workflows/ci.yml)

> **CRAP (Change Risk Anti-Patterns) guardrail for TypeScript / JavaScript.**

> ⚠️ **Alpha (v0.2.x).** The analyzer is stable and self-tested, but the CLI surface and JSON schema may still change before v1.0.

`slopguard-typescript` measures **complex, undertested code** in TypeScript and JavaScript sources. It computes a weighted CRAP score combining cyclomatic and cognitive complexity with line coverage, and prints a structured report you can pipe into `jq` or fail CI on. Its `mutate` command checks that the tests actually catch changes to the code (see [Mutation testing](#mutation-testing)). It is the TypeScript sibling of [slopguard-swift](https://github.com/JeevanThandi/SlopGuard-Swift) — same formula, same schema, same UX.

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

# Mutation testing: change the code, run the tests, list the changes no test caught
slopguard-ts mutate --path src/store.ts
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
| `mutate`  | Apply one small change at a time to the sources, run the tests against each, report the changes no test caught (text or JSON). |
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

## Mutation testing

Coverage says a line ran during a test. It does not say a test would fail if the line were wrong. `slopguard-ts mutate` checks that.

It makes one small change to the source (a *mutant*), runs the tests, and puts the original back. It does this for every mutant it can generate. A mutant that makes a test fail is **killed**. A mutant that every test passes with has **survived**: no test checks that behaviour. The report lists each survivor with its file, line, column, original text, replacement text and enclosing method, so you or an agent can write the test that kills it.

This is the workflow Robert C. Martin describes in the video on [slopguard.dev](https://slopguard.dev): have the AI cover the code, run a mutation tester, and have the AI write a failing test for every mutant that survives. `analyze` is the other half of that workflow.

```bash
# One file
slopguard-ts mutate --path src/store.ts

# A directory, narrowed with globs (relative to --path, same rules as analyze)
slopguard-ts mutate --path src --include "core/**" --exclude "**/legacy/**"

# Only some operators
slopguard-ts mutate --path src --operators boundary,negate_conditional

# List the mutants without running any tests
slopguard-ts mutate --path src --dry-run

# Survivors as JSON, for an agent
slopguard-ts mutate --path src --json | jq '.mutants[] | select(.status == "survived")'

# Fail CI below an 80% mutation score
slopguard-ts mutate --path src --fail-under 80
```

### How a run works

1. Walk `--path` with the same include/exclude rules as `analyze` (test files are skipped by default) and generate the mutants. `--dry-run` stops here. So does a run with no mutant left to test (none generated, or all ignored).
2. Take the project's lock (see [Safety](#safety)). Run the test suite once, unmutated, with the exact command used for mutants: `vitest run --bail=1 --coverage.enabled=false --reporter=dot` or `jest --bail=1 --coverage=false --watchAll=false --ci`. It must pass, or the run stops with `baseline_failed`. Its duration sets the per-mutant timeout: 3 × the baseline time, rounded up to a whole second, plus 10 seconds, unless `--timeout` is given.
3. Run the suite once with coverage. A mutant on a line that no test executes gets `no_coverage` and is not run. `--no-coverage` skips this step and runs every mutant. This run never stops `mutate`. If it produces no coverage data, every mutant runs and the report adds a note.
4. For each remaining mutant, in file, line and column order: write it into the file, run the tests, restore the file. A run that exceeds the timeout is killed with its whole process group.

### Flags

| Flag | Meaning |
|------|---------|
| `-p, --path <path>` | Directory or single file to mutate. Default: `.` |
| `--include <glob...>` / `--exclude <glob...>` | Narrow the files, exactly as for `analyze`. `--no-default-excludes` drops the built-in excludes. |
| `--operators <ids...>` | Operators to apply, comma-separated or repeated. Default: all. |
| `--runner <vitest\|jest>`, `--project-dir <dir>` | Which runner to drive and where, exactly as for `analyze`. |
| `--no-coverage` | Skip the coverage run and test every mutant. |
| `--timeout <seconds>` | Per-mutant timeout, a positive number. Default: computed from the baseline run (step 2 above). |
| `--dry-run` | List the mutants. Run no tests and touch no files. |
| `--json` | Emit JSON to stdout. |
| `--fail-under <score>` | Exit `2` when the mutation score is below this value. A score of `n/a` never fails, and `--dry-run` ignores the flag. |
| `-v, --verbose` / `--quiet` | Stream the runner output / silence progress. |

`mutate` rejects the `analyze`-only flags `--threshold`, `--fail-over` and `--coverage-file`.

Exit codes: `0` success, `1` error, `2` score below `--fail-under`, `130`/`143`/`129` interrupted by SIGINT/SIGTERM/SIGHUP (the source is restored first).

### Operators

| id | Change |
|----|--------|
| `arithmetic` | `+`↔`-`, `*`↔`/`, `%`→`*`, and `+=`↔`-=`, `*=`↔`/=`, `%=`→`*=`. String concatenation is skipped. |
| `boolean_literal` | `true`↔`false` |
| `boundary` | `<`↔`<=`, `>`↔`>=` |
| `increment` | `++`↔`--` |
| `invert_negative` | `-x` → `x` |
| `logical` | `&&`↔`\|\|` |
| `negate_conditional` | `==`↔`!=`, `===`↔`!==`, `<`→`>=`, `<=`→`>`, `>`→`<=`, `>=`→`<` |
| `remove_call` | `save(x);` → `;` for a statement that is only a call (optionally awaited). The statement must sit directly in a block, a `case` or `default` clause, or the top level of a file, never in the unbraced body of an `if` or a loop. `console.*`, `super(...)` and `import(...)` are skipped. |
| `remove_not` | `!x` → `x` |

Type annotations, comments and strings are never mutated. Every slopguard port uses the same operator ids.

### Statuses and score

| Status | Meaning | Counts as |
|--------|---------|-----------|
| `killed` | A test failed. | detected |
| `timeout` | The run exceeded the timeout, usually an infinite loop. | detected |
| `survived` | Every test passed. | undetected |
| `no_coverage` | No test executes the line. | undetected |
| `compile_error` | The mutant did not type-check: jest reports `Test suite failed to run` with a ts-jest `error TS…` diagnostic. vitest strips types, so it never reports this status. | excluded |
| `ignored` | An ignore marker switched it off. | excluded |
| `pending` | Not run: a `--dry-run` listing, or a mutant of a file that changed during the run. | excluded |

`mutationScore = (killed + timeout) / (killed + timeout + survived + no_coverage) × 100`. The score is `null` in JSON (`n/a` in text) when no mutant counts towards it, which is always the case in a dry run.

### Equivalent mutants

Some mutants change nothing observable, so no test can kill them. `if (s > max) max = s` behaves the same with `>=`, because assigning an equal value changes nothing. Mark such a line with a comment on the line itself, or on a comment line directly above it:

```ts
if (s > max) max = s; // slopguard-ignore-mutant(boundary): assigning an equal max changes nothing
```

`slopguard-ignore-mutant` alone ignores every operator on the line. `slopguard-ignore-mutant(boundary,logical)` ignores only the listed operators.

### JSON output

`--json` emits a versioned report (`reportType: "mutation"`, `schemaVersion: "1"`), keys sorted, shared with the other ports. This excerpt comes from the `sample-apps/todo-list` fixture before it had a test for `remaining`:

```json
{
  "mutants": [
    {
      "column": 37,
      "file": "todoStore.ts",
      "id": "todoStore.ts:27:37:remove_not",
      "line": 27,
      "method": "TodoStore.remaining.get",
      "operator": "remove_not",
      "original": "!",
      "replacement": "",
      "status": "survived"
    }
  ],
  "summary": {
    "compileErrors": 0, "fileCount": 3, "ignored": 0, "killed": 6, "mutantCount": 7,
    "mutationScore": 85.71428571428571, "noCoverage": 0, "pending": 0, "survived": 1, "timedOut": 0
  }
}
```

The full report also carries `coverageAvailable`, `generatedAt`, `notes`, `operators`, `projectRoot`, `runner`, `sourceRoot`, `timeoutSeconds`, `tool` and `toolVersion`.

### Safety

`mutate` writes to your source files, one file at a time, and always puts them back:

* The original bytes stay in memory and in a backup under the OS temp directory. The timestamps stay in memory. Both are written back after every test run, when an error occurs, and on SIGINT, SIGTERM or SIGHUP.
* A journal names the file that holds a mutant and the mutant's hash. If the process is killed without warning (for example by SIGKILL), the next `mutate` run for that project restores the file, but only when the file still holds exactly that mutant. An edit made after the kill is never overwritten. After a power loss, this works only if the OS temp directory survives the restart. If it does not, check the files under `--path` against version control.
* Before each mutant is written, the file is compared with the bytes the mutants were planned from. If you or another tool changed the file before its first mutant or between two mutants, `mutate` writes nothing more to it, reports its remaining mutants as `pending`, and adds a note. That edit is kept.
* An edit saved while a mutant is in the file is not detected. The restore writes the original bytes over it, and no note is added. A mutant stays in the file for the whole of its test run, so do not edit files under `--path` while `mutate` runs.
* Only one `mutate` run per project can hold the lock. A second run stops with `mutation_in_progress`.
* `--dry-run` writes nothing.

## Why it exists

Test coverage alone says "this code ran in a test"; complexity alone says "this code has many paths." Neither tells you whether the *risky* code is tested. CRAP combines them: a method with 20 branches and 0% coverage scores 420; the same method at 100% coverage scores 20 (just its complexity). The score lights up the code most likely to break under a refactor *and* be the hardest to verify the fix for.

## What counts as a method

Functions, class methods, constructors, get/set accessors, static blocks, and **named** arrow functions / function expressions (`const handler = () => {}`, object properties, class fields). Anonymous inline callbacks don't get their own entry — their branches count toward the enclosing method, with a cognitive nesting bump for the callback body, per the Sonar spec.

Default excludes keep noise out: `node_modules`, `dist`/`build`/`out`/`coverage`, `*.d.ts`, `*.min.js`, generated code, and test files (`*.test.*`, `*.spec.*`, `__tests__/`, `test(s)/`). Analyze test code itself with `--no-default-excludes`.

## Posture

* **Two top-level runtime dependencies** — `typescript` (Apache-2.0, the official parser) and `commander` (MIT).
* **The only subprocess slopguard-typescript spawns is the project's own test runner**, from the project's own `node_modules/.bin`.
* slopguard-typescript opens no network connections of its own and sends no telemetry. `analyze` never writes to your sources. `mutate` does, one file at a time, and restores every file (see [Safety](#safety)). See [`SECURITY.md`](SECURITY.md) for the full threat model and how to report a vulnerability.
* **MIT licensed** ([`LICENSE`](LICENSE)).

## Architecture

```
src/
├── core/             # CRAP formula, models, ComplexityVisitor, DirectoryAnalyzer, formatters
│   └── mutation/     # operators, MutantGenerator, ignore markers, MutationPlanner (pure, no I/O)
├── coverage/         # runner detection, test runner driver, istanbul CoverageIndex, AnalysisPipeline
├── mutation/         # CommandRunner (process groups, timeouts), WorkspaceGuard, MutationPipeline
└── cli/              # commander entry: analyze / mutate / version
```

## Development

```bash
npm install
npm test                                            # builds + unit & integration tests
node dist/cli/main.js analyze --path src            # dogfood
node dist/cli/main.js analyze --path sample-apps/todo-list/src  # known-good fixture
```

We dogfood slopguard-typescript against its own sources *and* against the [`sample-apps/`](sample-apps/) fixtures. The fixtures are deliberately tiny, fully covered, low-complexity packages — running the analyzer against them should always produce the same near-zero CRAP report. Drift against that baseline is a regression signal in the analyzer itself (asserted in `tests/integration.test.ts`). The todo-list fixture is also the mutation baseline: its tests kill all 7 of its mutants (asserted in `tests/mutationIntegration.test.ts` and in CI).

## Roadmap

* v0.1 shipped the CLI, the full core, coverage through vitest and jest, and istanbul interchange. ✅
* v0.2 added `mutate`, a mutation tester whose operators, statuses and JSON report are shared by all five ports. ✅
* v0.3 will add `node --test` and bun runners, and SARIF output for GitHub code scanning.
* v0.4 will add a per-PR diff mode (`slopguard-ts diff origin/main…HEAD`).

## Contributing

Issues and pull requests are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). CI keeps the suite green on Node 18.17/20/22, enforces 100% coverage, and asserts the analyzer stays under its own threshold. Changes are tracked in [`CHANGELOG.md`](CHANGELOG.md).
