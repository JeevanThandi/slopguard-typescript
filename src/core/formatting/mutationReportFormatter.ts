import { MutantResult, MutantStatus, MutationReport, MutationSummary } from "../mutation/models.js";
import { SlopguardVersion } from "../version.js";
import { stableStringify } from "./crapReportFormatter.js";

/**
 * Pure renderers for `MutationReport`: a text block for people and canonical
 * JSON (sorted keys) for agents and CI. The layout is shared with every
 * slopguard port.
 */

/** Longest `original` / `replacement` shown in the text listing, in characters. */
const SNIPPET_LIMIT = 40;

/** Sections that list mutants, in display order. */
const SECTIONS: ReadonlyArray<{ status: MutantStatus; title: (n: number) => string }> = [
  { status: "survived", title: (n) => `Survived (${n}) — tests still pass with these changes` },
  { status: "no_coverage", title: (n) => `No coverage (${n}) — no test runs these lines` },
  { status: "timeout", title: (n) => `Timed out (${n}) — counted as killed` },
  { status: "pending", title: (n) => `Mutants (${n}, not run)` },
];

export function prettyMutationReport(report: MutationReport): string {
  let out = header(report);
  out += "\n";
  if (report.notes.length > 0) {
    out += "Notes\n";
    for (const note of report.notes) out += `  • ${note}\n`;
    out += "\n";
  }
  out += summary(report.summary);
  for (const section of SECTIONS) {
    const mutants = report.mutants.filter((m) => m.status === section.status);
    if (mutants.length === 0) continue;
    out += `\n${section.title(mutants.length)}\n`;
    for (const mutant of mutants) out += `  ${listingLine(mutant)}\n`;
  }
  return out;
}

/** Canonical JSON encoding — sorted keys, so the output diffs cleanly in CI. */
export function jsonMutationReport(report: MutationReport, prettyPrinted = true): string {
  return stableStringify(report, prettyPrinted ? 2 : 0);
}

function header(report: MutationReport): string {
  const notRun = "(not run)";
  const timeout = report.timeoutSeconds === null ? notRun : `${report.timeoutSeconds}s per mutant`;
  return (
    `${SlopguardVersion.toolName} ${report.toolVersion} — mutation report (schema ${report.schemaVersion})\n` +
    `source:    ${report.sourceRoot}\n` +
    `project:   ${report.projectRoot ?? notRun}\n` +
    `runner:    ${report.runner ?? notRun}\n` +
    `timeout:   ${timeout}\n`
  );
}

function summary(s: MutationSummary): string {
  const rows: Array<[string, string | number]> = [
    ["files:", s.fileCount],
    ["mutants:", s.mutantCount],
    ["killed:", s.killed],
    ["timed out:", s.timedOut],
    ["survived:", s.survived],
    ["no coverage:", s.noCoverage],
    ["compile errors:", s.compileErrors],
    ["ignored:", s.ignored],
  ];
  if (s.pending > 0) rows.push(["pending:", s.pending]);
  rows.push(["score:", s.mutationScore === null ? "n/a" : `${s.mutationScore.toFixed(2)}%`]);
  return "Summary\n" + rows.map(([label, value]) => `  ${label.padEnd(16)}${value}\n`).join("");
}

function listingLine(m: MutantResult): string {
  const change = `\`${snippet(m.original)}\` → \`${snippet(m.replacement)}\``;
  const method = m.method === null ? "" : `  ${m.method}`;
  return `${m.file}:${m.line}:${m.column}  ${m.operator}  ${change}${method}`;
}

/** Collapse whitespace runs and cap the length, so multi-line statements stay on one line. */
export function snippet(text: string): string {
  const flat = Array.from(text.replace(/\s+/g, " "));
  if (flat.length <= SNIPPET_LIMIT) return flat.join("");
  return flat.slice(0, SNIPPET_LIMIT - 1).join("") + "…";
}
