# Security Policy

## Reporting a vulnerability

Please report suspected security issues **privately**, not in public issues
or pull requests.

Open a [GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository — that is the preferred and only supported channel.

We aim to acknowledge reports within **3 business days** and to publish a fix
within **30 days** for confirmed issues.

## Supported versions

Until v1.0, only the **latest minor release** receives security patches. Once
v1.0 ships, we will support the latest two minor releases.

| Version | Supported |
|---------|-----------|
| 0.2.x   | ✅        |
| 0.1.x   | ❌        |

## Threat model

`analyze` is read-only over the source code it analyzes. `mutate` is not: it
writes mutants into your source files (see "Mutation testing" below).

* It parses `.ts` / `.tsx` / `.js` / `.jsx` (and the `.mts`/`.cts`/`.mjs`/`.cjs` variants) via the [TypeScript compiler API](https://github.com/microsoft/TypeScript) — it does **not** import, link, or execute your code in the slopguard process.
* In the default (auto) coverage mode it runs your project's **existing test suite** via your project's own runner — it spawns `node_modules/.bin/vitest` or `node_modules/.bin/jest` as a child process, with arguments passed as argv (never concatenated into a shell command). This is the same command you would run yourself; it is the **only** subprocess slopguard spawns (`mutate` spawns the same runner, once per mutant). To analyze without running any tests, use `--no-coverage` (complexity only) or `--coverage-file` (ingest a coverage report you already produced).
* The child runner inherits the ambient environment plus `CI=1` and `FORCE_COLOR=0`, so it behaves as it would in your own CI. slopguard itself does not read environment variables for credentials or tokens.

Specifically, slopguard-typescript does **not**:

* Send telemetry or analytics anywhere.
* Open outbound network connections of its own.
* Execute, link, or import your code into its own process.
* Modify or write to your source files during `analyze`. (Coverage is written to, and deleted from, a slopguard-owned temp directory.)

## Mutation testing

`mutate` edits source files in place, one file at a time, and restores each
one:

* It writes only the files under `--path` that the include/exclude rules
  select, and only one mutant at a time. `--dry-run` writes nothing.
* The original bytes and timestamps are written back after every test run,
  when an error occurs, and on SIGINT, SIGTERM or SIGHUP.
* A file that changes before its first mutant or between two mutants (an edit
  by you or another tool) gets no further mutants, so that edit is kept. An
  edit saved while a mutant is in the file is not detected: the restore writes
  the original bytes over it. Do not edit files under `--path` while `mutate`
  runs.
* A lock, a journal and a backup of the file being mutated live in
  `<os temp dir>/slopguard-mutate/<hash of the project path>/`, never inside
  the project. After a hard kill, the next `mutate` run for the project restores
  the file only when it still holds exactly the journaled mutant. A restart
  that clears the OS temp directory also clears the journal and the backup,
  and a file that held a mutant then stays mutated.
* Each mutant runs your test suite, so a mutant can change what your tests do
  (for example a test that writes files). Run `mutate` where you would run your
  tests, and commit or stash work you care about before a long run.

## Supply-chain integrity

* The dependency graph is pinned by `package-lock.json`; `npm ci` installs exactly those versions.
* The published npm package ships only the compiled `dist/`, `README.md`, and `LICENSE` (enforced by the `files` allowlist in `package.json`) — no tests, fixtures, or source.
* npm **provenance** attestation (`npm publish --provenance` from CI) is planned for a later release. Until then, verify the package contents against this repository at the tagged commit, or build from source (`npm install && npm run build`).

## Dependencies

slopguard-typescript depends on (top-level, runtime):

| Dependency   | License    | Purpose |
|--------------|------------|---------|
| `typescript` | Apache-2.0 | Parsing; cyclomatic & cognitive complexity. |
| `commander`  | MIT        | CLI argument parsing. |

Coverage is gathered by driving the **project's own** test runner (vitest or
jest); slopguard does not bundle a test runner of its own.
