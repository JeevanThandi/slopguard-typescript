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
| 0.1.x   | ✅        |

## Threat model

slopguard-typescript is read-only over the source code it analyzes:

* It parses `.ts` / `.tsx` / `.js` / `.jsx` (and the `.mts`/`.cts`/`.mjs`/`.cjs` variants) via the [TypeScript compiler API](https://github.com/microsoft/TypeScript) — it does **not** import, link, or execute your code in the slopguard process.
* In the default (auto) coverage mode it runs your project's **existing test suite** via your project's own runner — it spawns `node_modules/.bin/vitest` or `node_modules/.bin/jest` as a child process, with arguments passed as argv (never concatenated into a shell command). This is the same command you would run yourself; it is the **only** subprocess slopguard spawns. To analyze without running any tests, use `--no-coverage` (complexity only) or `--coverage-file` (ingest a coverage report you already produced).
* The child runner inherits the ambient environment plus `CI=1` and `FORCE_COLOR=0`, so it behaves as it would in your own CI. slopguard itself does not read environment variables for credentials or tokens.

Specifically, slopguard-typescript does **not**:

* Send telemetry or analytics anywhere.
* Open outbound network connections of its own.
* Execute, link, or import your code into its own process.
* Modify or write to your source files. (Coverage is written to, and deleted from, a slopguard-owned temp directory.)

## Supply-chain integrity

* The dependency graph is pinned by `package-lock.json`; `npm ci` installs exactly those versions.
* The published npm package ships only the compiled `dist/`, `README.md`, and `LICENSE` (enforced by the `files` allowlist in `package.json`) — no tests, fixtures, or source.
* npm **provenance** attestation (`npm publish --provenance` from CI) is planned before v0.2. Until then, verify the package contents against this repository at the tagged commit, or build from source (`npm install && npm run build`).

## Dependencies

slopguard-typescript depends on (top-level, runtime):

| Dependency   | License    | Purpose |
|--------------|------------|---------|
| `typescript` | Apache-2.0 | Parsing; cyclomatic & cognitive complexity. |
| `commander`  | MIT        | CLI argument parsing. |

Coverage is gathered by driving the **project's own** test runner (vitest or
jest); slopguard does not bundle a test runner of its own.
