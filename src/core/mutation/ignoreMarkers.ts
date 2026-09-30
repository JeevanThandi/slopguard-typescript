import { isMutationOperator, MutationOperator } from "./operators.js";

/**
 * The comment marker that switches mutants off. Used for equivalent mutants —
 * changes with no observable effect, which no test can kill:
 *
 *   if (a > max) { // slopguard-ignore-mutant(boundary): equal values assign the same max
 *
 * - `slopguard-ignore-mutant` ignores every mutant on its line.
 * - `slopguard-ignore-mutant(boundary,logical)` ignores only those operators.
 * - On a line holding only a comment, the marker applies to the next line.
 */
export const IGNORE_MARKER = "slopguard-ignore-mutant";

/**
 * Whether a trimmed line holds only a comment: `//`, `/*`, or a `*` that
 * continues a block comment. A `*` followed by anything else is code (a
 * generator method `*gen()`, a continued multiplication).
 */
export const COMMENT_ONLY: RegExp = /^(\/\/|\/\*|\*(\s|\/|$))/;

/** Ignored operators per 1-based line; `"all"` switches off every operator. */
export type IgnoreMap = ReadonlyMap<number, ReadonlySet<MutationOperator> | "all">;

/** Find every marker in a file's lines (index 0 = line 1). A plain text search. */
export function parseIgnoreMarkers(lines: readonly string[], commentOnly: RegExp = COMMENT_ONLY): IgnoreMap {
  const map = new Map<number, ReadonlySet<MutationOperator> | "all">();
  lines.forEach((text, index) => {
    const at = text.indexOf(IGNORE_MARKER);
    if (at < 0) return;
    const scope = markerScope(text.slice(at + IGNORE_MARKER.length));
    const line = commentOnly.test(text.trimStart()) ? index + 2 : index + 1;
    const existing = map.get(line);
    if (existing === "all" || scope === "all") {
      map.set(line, "all");
    } else {
      map.set(line, new Set([...(existing ?? []), ...scope]));
    }
  });
  return map;
}

/** `(a,b)` right after the marker narrows it to those operators; unknown ids are dropped. */
function markerScope(rest: string): ReadonlySet<MutationOperator> | "all" {
  if (!rest.startsWith("(")) return "all";
  const close = rest.indexOf(")");
  const body = close < 0 ? rest.slice(1) : rest.slice(1, close); // slopguard-ignore-mutant(boundary): rest starts with "(", so ")" is never at index 0
  return new Set(
    body
      .split(",")
      .map((id) => id.trim())
      .filter(isMutationOperator)
  );
}

export function isIgnored(map: IgnoreMap, line: number, operator: MutationOperator): boolean {
  const scope = map.get(line);
  if (scope === undefined) return false;
  return scope === "all" || scope.has(operator);
}
