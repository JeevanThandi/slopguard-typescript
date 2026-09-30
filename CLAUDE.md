# CLAUDE.md — slopguard-typescript

Guidance for Claude when working in this repo. Read this first.

## What this is

`slopguard-typescript` (CLI: `slopguard-ts`) is the **TypeScript / JavaScript
port** of slopguard — a CRAP (Change Risk Anti-Patterns) guardrail. It scores
every function/method by **complexity × lack-of-coverage** (wCRAP) and emits a
text or JSON report you can gate CI on. Its `mutate` command is a mutation
tester: it writes one small change (a mutant) at a time into the sources, runs
the project's vitest or jest, restores the file, and reports the mutants no
test catches.

**Parity mandate:** this is the **reference port for intent**. The siblings
follow what this port does, so a change here is a change to the shared
contract. The wCRAP formula, the schema-2 JSON shape, the CLI UX (flags, exit
codes, stderr/stdout split) and the error-envelope shape are shared with four
sibling ports — don't change them unilaterally here, or you break cross-tool
consumers and drift from the siblings:

- Go: https://github.com/JeevanThandi/slopguard-go
- Swift: https://github.com/JeevanThandi/SlopGuard-Swift
- Kotlin: https://github.com/JeevanThandi/slopguard-kotlin
- Python: https://github.com/JeevanThandi/slopguard-python

`mutate` follows a second shared contract, implemented by all five ports: the
same core flags, operator ids, statuses, JSON report (`reportType:
"mutation"`, schema 1), text layout, progress lines, note wording, exit codes
and error codes. Each port keeps the runner flags of its own `analyze`
(`--runner` here). The four ports that edit files in place (TypeScript,
Python, Kotlin, Swift) also share the guard-directory layout; Go passes each
mutant to `go test -overlay` and needs no guard. This port is the reference
implementation (`src/mutation/`, `src/core/mutation/`,
`src/core/formatting/mutationReportFormatter.ts`), and the siblings copy its
output character for character. Change any of it only together with the
siblings.

## Environment

Node 18.17+ (CI runs 18.17, 20 and 22); `node` and `npm` are on PATH. Install
**both** dependency trees before running tests — the end-to-end tests and
the baselines drive the fixture's **own** vitest, so the fixture needs its own
`node_modules`:

```bash
npm ci
npm --prefix sample-apps/todo-list ci
```

`dist/` is build output (gitignored). The CLI subprocess tests and every
command below run `dist/cli/main.js`, so rebuild after each source change: the
subprocess tests are skipped when `dist/cli/main.js` is missing, and a stale
`dist/` tests old code.

`mutate` writes mutants into the real files under `--path`. While a `mutate`
run on this repo's own `src/` is in progress, don't build, don't run the test
suite and don't edit that file: it holds a mutant for most of the run.
Tests that mutate the fixture work on a temporary copy
(`copyTodoList()` in `tests/mutationIntegration.test.ts`), because other test
files run the checked-in fixture's tests in parallel.

## Build / test / run

```bash
npm run build           # tsc -> dist/
npm test                # pretest builds, then vitest run
npm run test:coverage   # vitest run --coverage; enforces the 100% gate
npm run dogfood         # build + analyze our own src with real coverage
```

Run it against itself:

```bash
node dist/cli/main.js analyze --path src                   # full, drives our own vitest for coverage
node dist/cli/main.js analyze --path src --no-coverage     # fast, complexity-only
node dist/cli/main.js analyze --path src --json | jq '.methods | sort_by(-.crap)[:10]'
node dist/cli/main.js mutate --path src --dry-run          # list every mutant in src (~640), run nothing
node dist/cli/main.js mutate --path src/core/crap.ts       # one file: 11 mutants, 10 killed, 1 ignored
node dist/cli/main.js mutate --path sample-apps/todo-list/src   # the mutation baseline (7 killed)
```

`mutate` runs the whole test suite once per mutant (the `crap.ts` run above
took about 9 minutes), so dogfood it on one file, never on all of `src/`.
`--dry-run` lists the mutants for free.

## Architecture

ESM TypeScript (`"type": "module"`, NodeNext), compiled by `tsc` to `dist/`.
Two runtime dependencies: `typescript` (the parser) and `commander` (CLI).
Everything the CLI uses is re-exported from `src/index.ts`, the library entry.

- **`src/core/`** — pure analysis, no subprocesses. `crap.ts` (the formula),
  `models.ts` (schema-2 types, method ids), `analysis/` (`ComplexityVisitor`,
  the single-pass cyclomatic + cognitive walk over the TS compiler AST;
  `FileAnalyzer` + `parseSourceFile`; `DirectoryAnalyzer`, whose `listFiles`
  walk is shared by `analyze` and `mutate`; `glob.ts`), `aggregation/`
  (`CrapAggregator`, `CoverageProvider`), `formatting/`
  (`crapReportFormatter.ts` with `stableStringify`,
  `mutationReportFormatter.ts`), `errors.ts`, `progressReporter.ts`,
  `version.ts`.
- **`src/core/mutation/`** — pure mutant planning, no I/O. `operators.ts` (the
  nine shared ids, `parseOperators`), `mutantGenerator.ts` (AST walk →
  `MutantSite`s), `ignoreMarkers.ts`, `mutationPlanner.ts` (generate → filter
  by operator → sort → enclosing method via `ComplexityVisitor` → ignore
  markers), `models.ts` (statuses, `MutantResult`, `MutationReport`,
  `summarize` + score maths, `applyMutant`, `compareSites`, `mutantId`).
- **`src/coverage/`** — drives the test runner for `analyze` and for `mutate`'s
  coverage baseline. `projectRootDiscovery.ts` (nearest `package.json` above
  `--path`), `runnerDetection.ts` (vitest/jest signals,
  `node_modules/.bin/<runner>`, coverage argv), `testRunner.ts` (spawns the
  runner with a forced istanbul `coverage-final.json` in a temp dir),
  `istanbul.ts` + `coverageIndex.ts` (per-line lookup, basename + longest-suffix
  path fallback), `outputTail.ts` (bounded 8 KiB output tail),
  `analysisPipeline.ts` (orchestrator with auto / prebuilt / none modes,
  `loadCoverageIndex`).
- **`src/mutation/`** — the only code that writes to user sources.
  `commandRunner.ts` (baseline and mutant command, `CI=1`, own process group,
  timeout kills the whole group), `workspaceGuard.ts` (lock + journal + backup
  in `<os.tmpdir()>/slopguard-mutate/<hash>/`, in-place write, restore,
  stale-lock recovery, changed-file check), `mutationPipeline.ts` (plan →
  guard → plain baseline → coverage baseline → one run per mutant → report;
  signal handlers, `classify`, note wording).
- **`src/cli/`** — commander entry. `main.ts` (`buildProgram`, `main`, the
  symlink-safe entry guard, the inline `version` command), `analyze.ts` (the
  default subcommand), `mutate.ts`.
- **`sample-apps/todo-list/`** — a standalone vitest project used as the CI
  regression baseline for both commands (`analyze`: 3 files, 8 methods, 0
  crappy, >95% coverage; `mutate`: 7 mutants, 7 killed, 0 survived). The
  `**/sample-apps/**` default exclude keeps it out of scans; pass
  `--path sample-apps/...` explicitly.

## Key invariants — don't break these

- **wCRAP formula** (`src/core/crap.ts`): `crapScore(comp, cov) = comp² ×
  (1 − cov/100)³ + comp`, fed `comp = weightedComplexity = sqrt(cyclomatic ×
  cognitive)`. Inputs are clamped; the default threshold is 30.
- **Cyclomatic** counting (base 1): `if`, `for`/`for-in`/`for-of`, `while`,
  `do`, each non-default `case`, `catch`, ternary, `&&`, `||`, `??` (and their
  compound assignments). **Cognitive** follows the SonarSource 2023 spec
  (whole `switch` = one increment, nesting-amplified, boolean-run collapse,
  labelled jumps fundamental, inline callbacks bump nesting but get no entry,
  early exits free). `tests/complexityVisitor*.test.ts` pin exact expected
  numbers — if you touch the analyzer, those tests are the contract.
- **Lexical type aggregation.** A method belongs to its innermost enclosing
  type (class, interface, enum, namespace, method-bearing object literal),
  like the Swift and Kotlin ports — not Go's receiver-based rollup.
- **Schema 2 JSON** (`CURRENT_SCHEMA_VERSION = "2"`), shared with every port.
  **Keys are sorted at every level** by `stableStringify` for diff-stable
  output. `generatedAt` is `Date.toISOString()` (UTC, ms, `Z`). Method `id` is
  `file#qualifiedName@startLine`.
- **Coverage is an artifact, never an input.** Auto mode runs the project's own
  vitest/jest with flags that force an istanbul `coverage-final.json` into a
  slopguard-owned temp dir, joins it, and deletes it; the project's coverage
  config is untouched. Failing tests don't abort (a note is attached), but a
  failed run with no coverage output is `test_run_failed`. `--coverage-file`
  (pre-built istanbul data) and `--no-coverage` are the escape hatches.

### `mutate` invariants

- **Report shape:** `reportType: "mutation"`, `schemaVersion: "1"`
  (`MUTATION_SCHEMA_VERSION`), versioned separately from the CRAP report, keys
  sorted by the same `stableStringify`. Statuses: `killed`, `survived`,
  `timeout`, `no_coverage`, `compile_error`, `ignored`, `pending`.
  `mutationScore = (killed + timeout) / (killed + timeout + survived +
  no_coverage) × 100`, unrounded, `null` when that denominator is 0 (always in
  a dry run). Summary counts sum to `mutantCount`; `fileCount` includes files
  with no mutants. `runner`, `projectRoot` and `timeoutSeconds` are `null`
  (text: `(not run)`) in a dry run and when no mutant is left to run.
- **Operator ids are shared** and appear in `--operators`, the JSON `operator`
  field and ignore markers: `arithmetic`, `boolean_literal`, `boundary`,
  `increment`, `invert_negative`, `logical`, `negate_conditional`,
  `remove_call`, `remove_not`. Unknown ids → `invalid_argument`. Never rename
  one.
- **Mutant ids and order.** `id = <file>:<line>:<column>:<operator>`, `file`
  relative to `sourceRoot` with forward slashes; `line` and `column` are
  1-based and `column` counts **Unicode code points**, not UTF-16 units. Sort:
  file (byte-wise), line, column, operator id.
- **Generator rules** (pinned by `tests/mutantGenerator.test.ts`): only real
  syntax nodes mutate — never comments, strings or type positions
  (`ts.isTypeNode` stops the walk). `+`/`+=` with a stringy operand (string
  literal, template, or recursively a stringy `+`) is skipped. `remove_call`
  only takes a call statement (optionally awaited or parenthesised) directly
  in a block, `case`/`default` clause, module block or source file, skips
  `console.*`, `super(...)` and `import(...)`, and replaces it with `;`.
  `remove_not` never touches the postfix non-null `!`.
- **Token-join guard:** `remove_not` and `invert_negative` replace the token
  with one space instead of nothing when both neighbours are identifier
  characters (`return!x` must not become `returnx`).
- **Ignore marker:** plain text search per line. The bare
  `slopguard-ignore-mutant` ignores every operator, `(ids)` only those
  (unknown ids dropped, an unclosed list runs to the end of the line). On a
  comment-only line (`//`, `/*`, or `*` followed by whitespace, `/` or the line
  end) it applies to the next line.
- **Two-run baseline.** The plain baseline runs the exact mutant command
  (`mutantTestArguments`: vitest `run --bail=1 --coverage.enabled=false
  --reporter=dot`; jest `--bail=1 --coverage=false --watchAll=false --ci`),
  unmutated and without a timeout; non-zero → `baseline_failed` with the output
  tail. Its wall time sets the timeout: `ceil(3 × seconds) + 10`
  (`TIMEOUT_GRACE_SECONDS`), unless `--timeout` is given. Mutant runs keep
  coverage off even when the project's config enables it, so coverage
  thresholds can't fake kills.
- **The coverage run is never fatal.** It reuses `TestRunner` and
  `loadCoverageIndex`. A `SlopguardError` from the run, or no usable data (no
  report, unreadable, or zero files) → the no-coverage note, and every mutant
  runs (`coverageAvailable: false`). A non-zero exit with usable data keeps the
  data and adds the exit-code note. `no_coverage` means
  `methodCoverage(file, line, line) === 0` exactly; `null` (unknown) runs the
  mutant.
- **Classification** (`classify`): timeout → `timeout`; exit 0 → `survived`;
  `compile_error` **only** for jest output that says `Test suite failed to
  run` **and** carries an `error TS…` diagnostic (ts-jest); anything else →
  `killed`. vitest strips types, so a vitest run never yields `compile_error`.
  A runner that cannot launch is fatal (`runner_unavailable`), after the
  restore.
- **Workspace guard** (`WorkspaceGuard`): the guard dir
  `<os.tmpdir()>/slopguard-mutate/<first 16 hex of sha256(realpath(projectRoot))>/`
  is never inside the project, and its layout is shared with the other
  in-place ports (Python, Kotlin, Swift).
  `lock` is created with `wx` (exclusive) and holds the pid: a live pid that
  is not ours → `mutation_in_progress`; a dead pid → recover, delete, retry
  once. `journal.json` (`{file, mutantSha256}`) is written temp + rename before
  each mutant and deleted after the restore. `original` holds the file's bytes,
  written before its first mutant. Mutants are written in place (truncate +
  write, so inode, mode and hard links survive); the restore writes the
  original bytes back, then the original atime/mtime. Recovery restores a file
  only when its sha256 still equals the journal's; when the file has changed
  to anything but the backup, it keeps the backup as `original-<timestamp>`
  and adds a note.
- **Signal restore:** SIGINT/SIGTERM/SIGHUP handlers, installed only while the
  guard is held, kill the active process group, restore, release, print the
  progress line `slopguard: interrupted — restored <file>` and exit
  130/143/129. A failed restore prints the error even under `--quiet` and
  exits 1. The plain baseline and every mutant run start in their own process
  group (`detached: true` on POSIX); a timeout sends SIGKILL to `-pid`, so a
  hanging worker never outlives the run.
- **Changed-file guard:** right before each mutant is written, the file's
  bytes must equal the bytes the plan was built from. Otherwise
  `SourceChangedError` → that mutant and the rest of the file become `pending`
  (ignored ones stay `ignored`) and the changed-file note is added. Never
  splice a mutant into stale text: the write and the restore would both
  overwrite the user's edit. The check runs only before the write, so an edit
  saved while a mutant is in the file is still overwritten by the restore, with
  no note. README and SECURITY.md state this limitation and tell users not to
  edit files under `--path` during a run.
- **Text layout, note wording and progress lines** are copied character for
  character by the siblings (`mutationReportFormatter.ts`, `NOTE_*`,
  `changedFileNote`, `coverageExitNote`, the `[i/n]` progress line). Change
  them only together with the siblings.

## Conventions

- **100% coverage gate** — statements, branches, functions and lines
  (`vitest.config.ts` thresholds; CI fails below it). Genuinely unreachable
  defensive code may take a `/* v8 ignore … */` comment that states *why*.
  `src/core/aggregation/coverageProvider.ts` (type-only) is excluded.
- Errors are `SlopguardError` with a stable `code` (`SlopguardErrorCode` in
  `src/core/errors.ts`); surface them via `errorEnvelope` + `errorJSON`
  (`--json`: `{"error": {"code", "message"}}` on stderr) or `errorText`.
  Agents match on codes: add new ones to the union, never rename existing
  ones. `mutate` added `baseline_failed`, `mutation_in_progress` and
  `restore_failed`.
- Exit codes: 0 ok, 1 error, 2 `--fail-over` exceeded (`analyze`) or mutation
  score strictly below `--fail-under` (`mutate`; a `null` score never fails,
  and `--dry-run` ignores the flag), 130/143/129 when SIGINT/SIGTERM/SIGHUP
  stops `mutate`.
- **stdout carries only the report.** Progress goes to **stderr** via
  `ProgressReporter` (`slopguard: ` prefix); `--verbose` streams the runner's
  raw output there too, and `--quiet` wins over `--verbose`. Keep the split so
  piped JSON stays clean.
- Runner subprocesses get argv arrays (never a shell), the project-local
  `node_modules/.bin/<runner>` binary, and `CI=1` + `FORCE_COLOR=0`.
- The version lives in `package.json`, both root `version` fields of
  `package-lock.json` and `src/core/version.ts`; `tests/integration.test.ts`
  and `tests/formatter.test.ts` pin it.
- Match the surrounding code: naming, module layout, comment density. Comments
  explain *why*, not *what*.

## When verifying a change

```bash
npm ci && npm --prefix sample-apps/todo-list ci      # once per checkout
npm run build && npx vitest run --coverage           # the 100% gate must pass
node dist/cli/main.js analyze --path src --threshold 30 --fail-over 30 --json --quiet > /dev/null
# expect exit 0 — the CI dogfood gate (no method in src/ above wCRAP 30)
node dist/cli/main.js analyze --path sample-apps/todo-list/src --json --quiet \
  | jq -c '{files:.summary.fileCount, methods:.summary.methodCount, crappy:.summary.crappyMethodCount}'
# expect {"files":3,"methods":8,"crappy":0} — the regression baseline
node dist/cli/main.js mutate --path sample-apps/todo-list/src --json --quiet \
  | jq -c '{mutants:.summary.mutantCount, killed:.summary.killed, survived:.summary.survived, score:.summary.mutationScore}'
# expect {"mutants":7,"killed":7,"survived":0,"score":100} — the mutation baseline
node dist/cli/main.js version
# expect the version in package.json
```
