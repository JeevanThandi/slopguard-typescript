import path from "node:path";
import { aggregateCrap, crapScore, DEFAULT_CRAP_THRESHOLD } from "../crap.js";
import {
  CrapReport,
  CURRENT_SCHEMA_VERSION,
  FileReport,
  MethodCrap,
  methodId,
  TypeCrap,
  typeId,
} from "../models.js";
import { SlopguardVersion } from "../version.js";
import { CoverageProvider } from "./coverageProvider.js";

/**
 * Standing note on every schema-2 report so downstream consumers know the
 * `crap`-derived fields are driven by the weighted blend, not raw cyclomatic.
 * The reported score is `wCRAP` (weighted CRAP), not the classic Pearson
 * CRAP — cross-tool comparisons need adjustment for the change of input.
 */
const SCHEMA_TWO_NOTE =
  "Score is wCRAP (weighted CRAP) since schema 2: complexity input is " +
  "weightedComplexity = sqrt(cyclomatic × cognitive), not raw cyclomatic. " +
  "Both raw metrics ship under `complexity` (cyclomatic, McCabe) and " +
  "`cognitiveComplexity` (SonarSource 2023); the score itself is reported " +
  "under the existing `crap` field for schema continuity. Recursion " +
  "increment is deferred (known undercount vs Sonar parity).";

export interface AggregateArgs {
  fileReports: FileReport[];
  /** Used to resolve `FileReport.path` (relative) to an absolute path so the coverage provider can match it. */
  sourceRoot: string;
  /** Recorded on the report; not used for analysis. */
  coverageDataPath: string | null;
  threshold?: number;
  /** When null, coverage is treated as 0% — the worst-case so complexity alone surfaces loudly. */
  coverage: CoverageProvider | null;
  /** Diagnostic strings to surface alongside the report. */
  notes?: string[];
  generatedAt?: Date;
}

/**
 * Joins per-file complexity output with optional coverage data to produce the
 * final `CrapReport`. Stateless.
 */
export class CrapAggregator {
  aggregate(args: AggregateArgs): CrapReport {
    const threshold = args.threshold ?? DEFAULT_CRAP_THRESHOLD;
    const rootAbsolute = path.resolve(args.sourceRoot);
    const coverage = args.coverage;
    const coverageAvailable = coverage !== null;

    const methods: MethodCrap[] = [];
    let totalComplexity = 0;
    let totalCognitive = 0;
    let totalWeighted = 0;
    let totalCovered = 0;
    let totalExecutable = 0;

    for (const fileReport of args.fileReports) {
      const absoluteFilePath = absolutize(rootAbsolute, fileReport.path);
      for (const method of fileReport.methods) {
        const cov =
          coverage?.methodCoverage(absoluteFilePath, method.startLine, method.endLine) ??
          coverage?.fileCoverage(absoluteFilePath) ??
          0;

        // Schema 2: feed the weighted blend into the formula. Cyclomatic and
        // cognitive ride along on the report so consumers can see *why* the
        // score is what it is.
        const crap = crapScore(method.weightedComplexity, cov);
        const executable = Math.max(0, method.endLine - method.startLine + 1);

        methods.push({
          id: methodId(method),
          file: method.file,
          line: method.startLine,
          endLine: method.endLine,
          typeName: method.typeName,
          name: method.name,
          qualifiedName: method.qualifiedName,
          kind: method.kind,
          complexity: method.complexity,
          cognitiveComplexity: method.cognitiveComplexity,
          weightedComplexity: method.weightedComplexity,
          coverage: cov,
          crap,
          isCrappy: crap > threshold,
        });
        totalComplexity += method.complexity;
        totalCognitive += method.cognitiveComplexity;
        totalWeighted += method.weightedComplexity;
        totalCovered += (executable * cov) / 100;
        totalExecutable += executable;
      }
    }

    const types: TypeCrap[] = [];
    for (const fileReport of args.fileReports) {
      for (const typeMetric of fileReport.types) {
        const memberIds = new Set(typeMetric.methodIDs);
        const typeMethods = methods.filter((m) => m.file === fileReport.path && memberIds.has(m.id));
        const agg = aggregateCrap(typeMethods.map((m) => m.crap));
        const weightedCov = weightedCoverage(typeMethods);
        // Type-level weighted: sqrt(totalCyc × totalCog), mirroring the
        // method-level geometric mean, so the type-level score is consistent
        // with how individual methods are scored.
        const weightedTotal = Math.sqrt(
          typeMetric.totalComplexity * typeMetric.totalCognitiveComplexity
        );
        const aggregated = crapScore(weightedTotal, weightedCov);
        types.push({
          id: typeId(typeMetric),
          file: typeMetric.file,
          line: typeMetric.startLine,
          kind: typeMetric.kind,
          name: typeMetric.name,
          methodCount: typeMetric.methodCount,
          totalComplexity: typeMetric.totalComplexity,
          maxComplexity: typeMetric.maxComplexity,
          totalCognitiveComplexity: typeMetric.totalCognitiveComplexity,
          maxCognitiveComplexity: typeMetric.maxCognitiveComplexity,
          weightedTotalComplexity: weightedTotal,
          weightedCoverage: weightedCov,
          sumCrap: agg.sum,
          maxCrap: agg.max,
          aggregatedCrap: aggregated,
          isCrappy: aggregated > threshold || agg.max > threshold,
        });
      }
    }

    methods.sort((a, b) => b.crap - a.crap);
    types.sort((a, b) => b.aggregatedCrap - a.aggregatedCrap);

    const crappyMethods = methods.filter((m) => m.isCrappy).length;
    const crappyTypes = types.filter((t) => t.isCrappy).length;
    const count = methods.length;
    const avgCrap = count === 0 ? 0 : methods.reduce((s, m) => s + m.crap, 0) / count;
    const weighted =
      coverageAvailable && totalExecutable > 0
        ? (totalCovered / totalExecutable) * 100
        : coverageAvailable
          ? 0
          : null;

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      tool: SlopguardVersion.toolName,
      toolVersion: SlopguardVersion.version,
      generatedAt: (args.generatedAt ?? new Date()).toISOString(),
      sourceRoot: rootAbsolute,
      coverageDataPath: args.coverageDataPath,
      threshold,
      coverageAvailable,
      // Prepend the schema-2 explanation so JSON consumers and CLI users see
      // the meaning shift loudly. Keep any caller-supplied notes after.
      notes: [SCHEMA_TWO_NOTE, ...(args.notes ?? [])],
      summary: {
        fileCount: args.fileReports.length,
        typeCount: types.length,
        methodCount: count,
        crappyMethodCount: crappyMethods,
        crappyTypeCount: crappyTypes,
        averageCrap: avgCrap,
        maxCrap: methods[0]?.crap ?? 0,
        averageComplexity: count === 0 ? 0 : totalComplexity / count,
        averageCognitiveComplexity: count === 0 ? 0 : totalCognitive / count,
        averageWeightedComplexity: count === 0 ? 0 : totalWeighted / count,
        weightedCoverage: weighted,
      },
      methods,
      types,
    };
  }
}

function weightedCoverage(methods: MethodCrap[]): number {
  if (methods.length === 0) return 0;
  let totalLines = 0;
  let weighted = 0;
  for (const m of methods) {
    const lines = Math.max(1, m.endLine - m.line + 1);
    totalLines += lines;
    weighted += m.coverage * lines;
  }
  // `lines` is always >= 1, so a non-empty method list has totalLines >= 1; the
  // empty case already returned above. The zero guard is defensive only.
  /* v8 ignore next */
  return totalLines === 0 ? 0 : weighted / totalLines;
}

function absolutize(rootAbsolute: string, relative: string): string {
  if (path.isAbsolute(relative)) return relative;
  return path.join(rootAbsolute, relative);
}
