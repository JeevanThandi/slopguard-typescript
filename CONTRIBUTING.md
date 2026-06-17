# Contributing

Thanks for your interest in slopguard-typescript.

## Ground rules

- **Open an issue first** for anything beyond a small fix, so we can agree on the approach before you spend time on it.
- Keep changes focused; one logical change per pull request.
- By contributing, you agree your work is licensed under the project's [MIT License](LICENSE).

## Development

```bash
npm install
npm --prefix sample-apps/todo-list ci   # the fixture's own deps (for the e2e baseline test)
npm test                                 # builds, then runs unit + integration tests
npm run test:coverage                    # same, with the 100% coverage gate enforced
node dist/cli/main.js analyze --path src # dogfood against our own sources
```

## What CI enforces

A pull request must keep all of these green (see `.github/workflows/ci.yml`):

- **Tests pass** on Node 18.17, 20, and 22.
- **100% coverage** — statements, branches, functions, and lines. The thresholds live in `vitest.config.ts`; a drop fails the build. Genuinely-unreachable defensive code may be excluded with a `/* v8 ignore … */` comment that states *why*.
- **We stay under our own threshold** — no method in `src/` exceeds wCRAP 30 (`--fail-over 30`).
- **The fixture baseline is unchanged** — `sample-apps/todo-list` must still report 3 files / 8 methods / 0 crappy / >95% coverage. Drift there signals an analyzer regression, not an app change; update the assertion deliberately if the change is intended.

## Style

Match the surrounding code: the existing naming, module layout, and comment density. Comments should explain *why*, not narrate *what*.
