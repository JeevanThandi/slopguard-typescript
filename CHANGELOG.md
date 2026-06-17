# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/JeevanThandi/slopguard-typescript/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JeevanThandi/slopguard-typescript/releases/tag/v0.1.0
