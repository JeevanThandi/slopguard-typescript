/**
 * Data models shared across the analysis pipeline. Pure data — no I/O.
 */

/**
 * What kind of declaration a metric describes. Used to render qualified names
 * and for downstream filtering (e.g. "show me only constructors").
 */
export type MethodKind =
  | "function"
  | "method"
  | "constructor"
  | "getter"
  | "setter"
  | "arrow"
  | "functionExpression";

/** What kind of enclosing type owns a method. Free functions use `null`. */
export type TypeKind = "class" | "interface" | "enum" | "namespace" | "object";

/**
 * Pure analysis output for a single declaration. No coverage data is attached
 * here — coverage is joined later by `CrapAggregator` so that this type stays
 * useful in no-coverage modes.
 */
export interface MethodMetric {
  /** The leaf name as written in source, e.g. `bar`, `constructor`, `value.get`. */
  readonly name: string;
  /**
   * Fully qualified name including the enclosing type chain, e.g.
   * `Outer.Inner.bar`. For free functions this equals `name`.
   */
  readonly qualifiedName: string;
  /** Name of the immediate enclosing type, if any. */
  readonly typeName: string | null;
  readonly kind: MethodKind;
  /** Path relative to the analysis root (forward-slash-normalized). */
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  /**
   * Cyclomatic complexity (McCabe). Counts every branching decision +1 from a
   * base of 1. Preserved for cross-tool comparability.
   */
  readonly complexity: number;
  /**
   * Cognitive complexity per the SonarSource 2023 spec. Designed to track how
   * hard the code is to *understand* rather than how many test cases it needs:
   * flat dispatch (large `switch`) is +1 total; nesting is amplified; early
   * exits are 0.
   */
  readonly cognitiveComplexity: number;
  /**
   * Geometric mean `sqrt(complexity × cognitiveComplexity)`. This is the value
   * `CrapAggregator` feeds into the CRAP formula since schema 2 — it dampens
   * cyclomatic-only false positives on flat dispatch while staying honest on
   * genuinely nested code.
   */
  readonly weightedComplexity: number;
}

/**
 * Stable identifier suitable for cross-tool references.
 * Format: `relative/path.ts#Qualified.Name@startLine`.
 */
export function methodId(m: Pick<MethodMetric, "file" | "qualifiedName" | "startLine">): string {
  return `${m.file}#${m.qualifiedName}@${m.startLine}`;
}

export function makeMethodMetric(args: Omit<MethodMetric, "weightedComplexity">): MethodMetric {
  const cyc = Math.max(0, args.complexity);
  const cog = Math.max(0, args.cognitiveComplexity);
  return { ...args, weightedComplexity: Math.sqrt(cyc * cog) };
}

/** Aggregated complexity for a single enclosing type (class/interface/enum/namespace). */
export interface TypeMetric {
  readonly kind: TypeKind;
  readonly name: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  /**
   * IDs of the methods that belong to this type. Used to look them up in the
   * flat `MethodMetric[]` produced by the same file analysis pass.
   */
  readonly methodIDs: string[];
  readonly methodCount: number;
  readonly totalComplexity: number;
  readonly maxComplexity: number;
  readonly totalCognitiveComplexity: number;
  readonly maxCognitiveComplexity: number;
}

export function typeId(t: Pick<TypeMetric, "file" | "name" | "startLine">): string {
  return `${t.file}#${t.name}@${t.startLine}`;
}

/**
 * The pure-syntactic analysis result for a single source file. Contains
 * complexity metrics for every declaration found, plus aggregations per
 * enclosing type.
 */
export interface FileReport {
  readonly path: string;
  readonly methods: MethodMetric[];
  readonly types: TypeMetric[];
}

/** A single method's CRAP entry in the final report. */
export interface MethodCrap {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
  readonly typeName: string | null;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: MethodKind;
  /** Cyclomatic complexity (McCabe). Preserved for cross-tool parity. */
  readonly complexity: number;
  /** Cognitive complexity (SonarSource 2023). */
  readonly cognitiveComplexity: number;
  /** `sqrt(complexity × cognitiveComplexity)` — feeds the CRAP formula since schema 2. */
  readonly weightedComplexity: number;
  readonly coverage: number;
  readonly crap: number;
  readonly isCrappy: boolean;
}

/** A type-level aggregation entry in the final report. */
export interface TypeCrap {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly kind: TypeKind;
  readonly name: string;
  readonly methodCount: number;
  readonly totalComplexity: number;
  readonly maxComplexity: number;
  readonly totalCognitiveComplexity: number;
  readonly maxCognitiveComplexity: number;
  /** `sqrt(totalComplexity × totalCognitiveComplexity)` — feeds `aggregatedCrap`. */
  readonly weightedTotalComplexity: number;
  readonly weightedCoverage: number;
  readonly sumCrap: number;
  readonly maxCrap: number;
  readonly aggregatedCrap: number;
  readonly isCrappy: boolean;
}

export interface ReportSummary {
  readonly fileCount: number;
  readonly typeCount: number;
  readonly methodCount: number;
  readonly crappyMethodCount: number;
  readonly crappyTypeCount: number;
  readonly averageCrap: number;
  readonly maxCrap: number;
  readonly averageComplexity: number;
  readonly averageCognitiveComplexity: number;
  readonly averageWeightedComplexity: number;
  readonly weightedCoverage: number | null;
}

/**
 * Top-level JSON payload emitted by the CLI's `--json` flag. Stable,
 * versioned (`schemaVersion`) so downstream tooling can rely on the shape.
 *
 * Schema 2 (current, shared with slopguard-swift): `cognitiveComplexity` +
 * `weightedComplexity` throughout; the `crap` / `aggregatedCrap` formula is
 * driven by the weighted blend (`sqrt(cyc × cog)`).
 */
export interface CrapReport {
  readonly schemaVersion: string;
  readonly tool: string;
  readonly toolVersion: string;
  readonly generatedAt: string;
  readonly sourceRoot: string;
  /**
   * Path of the coverage data file the report was joined against (the
   * istanbul `coverage-final.json`), or null when coverage was generated
   * ephemerally / unavailable. Analog of slopguard-swift's `xcresultPath`.
   */
  readonly coverageDataPath: string | null;
  readonly threshold: number;
  readonly coverageAvailable: boolean;
  /**
   * Human-readable diagnostic notes — surfaced when slopguard had to make a
   * judgement call the user should know about (e.g. "tests ran but coverage
   * wasn't gathered"). Additive in JSON output.
   */
  readonly notes: string[];
  readonly summary: ReportSummary;
  readonly methods: MethodCrap[];
  readonly types: TypeCrap[];
}

export const CURRENT_SCHEMA_VERSION = "2";
