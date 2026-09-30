# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-09-30

### Added

- `mutate` command: mutation testing. It applies one small change at a time to
  the sources, runs the project's vitest or jest against each mutant, restores
  the file, and reports every mutant as `killed`, `survived`, `timeout`,
  `no_coverage`, `compile_error`, `ignored` or `pending`, with a mutation
  score. It selects files exactly like `analyze` (`--path`, `--include`,
  `--exclude`, `--no-default-excludes`) and drives the same runner
  (`--runner`, `--project-dir`, `--verbose`, `--quiet`). Its own flags are
  `--operators` (nine operators shared with the other ports), `--dry-run`,
  `--timeout`, `--no-coverage`, `--json` (`reportType: "mutation"`, schema 1)
  and `--fail-under` (exit `2`).
- A passing unmutated baseline run is required (`baseline_failed`), and it sets
  the per-mutant timeout: 3 × its duration, rounded up to a whole second, plus
  10 seconds, unless `--timeout` is given. A coverage run marks mutants on
  lines no test executes as `no_coverage` without running them. The coverage
  run never stops the command. Without usable coverage data, every mutant runs
  and the report adds a note.
- `mutate` reports `compile_error` only for jest projects whose ts-jest type
  check fails (`Test suite failed to run` with an `error TS…` diagnostic).
  vitest strips types, so a failing vitest run always counts as `killed`.
- Workspace safety for in-place mutation: the original bytes and timestamps are
  restored after every run, on errors and on SIGINT/SIGTERM/SIGHUP; a journal in
  the OS temp directory lets the next run restore a file after a hard kill, when
  the file still holds that mutant; a per-project lock stops concurrent runs
  (`mutation_in_progress`); a file edited before its first mutant or between
  two mutants gets no further mutants, and its remaining mutants are reported
  as `pending`. An edit saved while a mutant is in the file is not detected,
  and the restore overwrites it. New error codes: `baseline_failed`,
  `mutation_in_progress`, `restore_failed`. `SECURITY.md` describes the safety
  model.
- `mutate` exits with `130` (SIGINT), `143` (SIGTERM) or `129` (SIGHUP) after
  it restores the source. A mutant run that exceeds the timeout is killed with
  its whole process group. On Windows only the direct child is killed.
- `slopguard-ignore-mutant` and `slopguard-ignore-mutant(<ids>)` comments mark
  equivalent mutants. A marker applies to its own line, or to the next line
  when it sits on a line that holds only a comment.
- The library entry point exports the mutation API: `MutationPipeline`,
  `MutationPlanner`, `MutantGenerator`, `WorkspaceGuard`, `CommandRunner`,
  `prettyMutationReport`, `jsonMutationReport`, the operator, status and report
  types, and helpers such as `parseSourceFile`, `loadCoverageIndex` and
  `OutputTail`. `DirectoryAnalyzer` gained `listFiles`, `FileAnalyzer` gained
  `analyzeSourceFile`, and `TestRunOutcome` gained `exitCode` and `outputTail`.
- The `sample-apps/todo-list` fixture gained a test that kills its one
  surviving mutant; CI pins its mutation baseline (7 mutants, 7 killed).

### Fixed

- A symlinked CLI (the normal case for `npm link` and global installs) ran
  nothing and exited silently. The entry-point guard compared `import.meta.url`
  (symlinks resolved by Node) against `process.argv[1]` (the symlink path), so
  the two never matched and `main()` was never dispatched. `argv[1]` is now
  canonicalised with `realpathSync` before comparison. Covered by a subprocess
  regression test that invokes the binary through a symlink.
- A fresh clone of the 0.1.0 commit did not build: `tsc` failed with `TS2307`
  because `src/coverage/` was missing. The unanchored `coverage/` rule in
  `.gitignore` also matched that directory, so its sources were never
  committed. The rule is now anchored to the repository root (`/coverage/`),
  and so is `/dist/`.

### Security

- Raised the dev toolchain to clear all `npm audit` advisories (was 6, incl. 2
  critical; now 0): vitest/`@vitest/coverage-v8` `^2` → `^3`, plus an `esbuild`
  `^0.28.1` override to pull a patched transitive. All were **dev-only** and
  unreachable in this project's headless usage; nothing shipped in the package
  was affected (runtime deps remain `typescript` + `commander`, zero transitive,
  zero advisories). Node 18.17 support and the 100% coverage gate are retained.

## [0.1.0] — 2026-06-17

Initial public release. The TypeScript/JavaScript sibling of
[slopguard-swift](https://github.com/JeevanThandi/SlopGuard-Swift) — same wCRAP
formula, same schema-2 JSON, same CLI UX.

### Added

- `analyze` command: walks a directory (or single file) of TS/JS sources,
  drives the project's own test runner for coverage, and emits a weighted CRAP
  report as text or JSON.
- `version` command: prints version metadata as JSON.
- Cyclomatic (McCabe) and cognitive (SonarSource 2023) complexity computed via
  the TypeScript compiler API; wCRAP = `(cyc × cog) × (1 − cov/100)³ + √(cyc × cog)`.
- Coverage gathered as an internal artifact by auto-detecting and driving
  **vitest** or **jest** into an istanbul `coverage-final.json`. Escape hatches:
  `--runner`, `--coverage-file` (any istanbul producer — nyc, c8, mocha),
  `--no-coverage`.
- Stable, machine-readable error codes and CI-friendly exit codes
  (`0` success, `1` error, `2` `--fail-over` exceeded).
- Glob include/exclude with built-in default excludes and
  `--no-default-excludes`; `--threshold`, `--project-dir`, `--verbose`/`--quiet`.
- `sample-apps/todo-list` fixture as a known-good regression baseline.

[Unreleased]: https://github.com/JeevanThandi/slopguard-typescript/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/JeevanThandi/slopguard-typescript/compare/b8941f72baa4dae6249182c79ef40ff012bbfd09...v0.2.0
[0.1.0]: https://github.com/JeevanThandi/slopguard-typescript/commit/b8941f72baa4dae6249182c79ef40ff012bbfd09
