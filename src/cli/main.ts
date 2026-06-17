#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { SlopguardVersion } from "../core/version.js";
import { makeAnalyzeCommand } from "./analyze.js";

/**
 * Build the top-level CLI program. `analyze` is the default subcommand and
 * `--path` defaults to the current directory — a bare `slopguard-ts` in a
 * project root just works. Exported (rather than constructed inline) so the
 * wiring can be exercised in-process by tests.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("slopguard-ts")
    .description(
      "CRAP (Change Risk Anti-Patterns) guardrail for TypeScript / JavaScript.\n\n" +
        "slopguard-ts finds complex, undertested code by combining cyclomatic and\n" +
        "cognitive complexity (parsed via the TypeScript compiler) with line coverage\n" +
        "gathered from the project's own test runner (vitest / jest). Use `analyze`\n" +
        "for one-shot scans and pipe `--json` into `jq` for downstream tooling.\n\n" +
        "Formula:  wCRAP(m) = (cyc × cog) × (1 − cov/100)³ + sqrt(cyc × cog)\n" +
        "Default crappy threshold: 30."
    )
    .version(SlopguardVersion.version)
    .addCommand(makeAnalyzeCommand(), { isDefault: true });

  program
    .command("version")
    .description("Print version metadata as JSON.")
    .action(() => {
      const payload = { name: SlopguardVersion.toolName, version: SlopguardVersion.version };
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    });

  return program;
}

/**
 * Parse argv and run. Any rejection from the command tree is turned into a
 * single-line stderr message and a non-zero exit code. The program is
 * injectable so the error path can be driven deterministically in tests.
 */
export async function main(argv: string[], program: Command = buildProgram()): Promise<void> {
  try {
    await program.parseAsync(argv);
  } catch (error) {
    process.stderr.write(`${SlopguardVersion.toolName}: ${String(error)}\n`);
    process.exitCode = 1;
  }
}

// Dispatch only when run as the CLI binary, so importing this module (e.g. in
// tests, to exercise buildProgram/main in-process) doesn't kick off a parse.
const invokedAsBinary =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
/* v8 ignore next -- entry dispatch; exercised by the CLI subprocess integration tests, invisible to in-process coverage */
if (invokedAsBinary) main(process.argv);
