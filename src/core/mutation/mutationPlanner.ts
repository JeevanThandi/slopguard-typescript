import ts from "typescript";
import { FileAnalyzer, parseSourceFile } from "../analysis/fileAnalyzer.js";
import { MethodMetric } from "../models.js";
import { isIgnored, parseIgnoreMarkers } from "./ignoreMarkers.js";
import { compareSites, MutantSite } from "./models.js";
import { MutantGenerator } from "./mutantGenerator.js";
import { MutationOperator } from "./operators.js";

/** A mutant plus everything known about it before any test run. */
export interface PlannedMutant {
  readonly site: MutantSite;
  /** Qualified name of the innermost enclosing method, or null for top-level code. */
  readonly method: string | null;
  /** Switched off by a `slopguard-ignore-mutant` marker. */
  readonly ignored: boolean;
}

/**
 * Plans the mutants for one source file: generates them, keeps the requested
 * operators, names each mutant's enclosing method (via the complexity
 * analyzer, so names match the CRAP report) and applies ignore markers.
 * Pure — no I/O.
 */
export class MutationPlanner {
  private readonly generator: MutantGenerator;
  private readonly analyzer: FileAnalyzer;

  constructor(generator: MutantGenerator = new MutantGenerator(), analyzer: FileAnalyzer = new FileAnalyzer()) {
    this.generator = generator;
    this.analyzer = analyzer;
  }

  /** Mutants for `source`, sorted by line, column and operator id. */
  plan(source: string, reportedPath: string, operators: readonly MutationOperator[]): PlannedMutant[] {
    const sourceFile = parseSourceFile(source, reportedPath);
    const methods = this.analyzer.analyzeSourceFile(sourceFile, reportedPath).methods;
    const ignores = parseIgnoreMarkers(sourceLines(sourceFile));
    return this.generator
      .generate(sourceFile, reportedPath)
      .filter((site) => operators.includes(site.operator))
      .sort(compareSites)
      .map((site) => ({
        site,
        method: enclosingMethod(methods, site.line),
        ignored: isIgnored(ignores, site.line, site.operator),
      }));
  }
}

/**
 * Qualified name of the innermost method whose line range contains `line`:
 * the smallest span wins, and on a tie the one that starts later.
 */
export function enclosingMethod(methods: readonly MethodMetric[], line: number): string | null {
  let best: MethodMetric | null = null;
  for (const method of methods) {
    if (line < method.startLine || line > method.endLine) continue;
    if (best === null || isInnermost(method, best)) best = method;
  }
  return best?.qualifiedName ?? null;
}

function isInnermost(candidate: MethodMetric, best: MethodMetric): boolean {
  const candidateSpan = candidate.endLine - candidate.startLine;
  const bestSpan = best.endLine - best.startLine;
  return candidateSpan < bestSpan || (candidateSpan === bestSpan && candidate.startLine > best.startLine);
}

/** The file's lines, split where the compiler splits them (so line numbers agree). */
function sourceLines(sourceFile: ts.SourceFile): string[] {
  const starts = sourceFile.getLineStarts();
  const text = sourceFile.text;
  return starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length));
}
