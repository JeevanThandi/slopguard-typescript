/**
 * Types for Istanbul's `coverage-final.json` — the interchange format every
 * mainstream JS/TS coverage tool can emit (jest's `json` coverageReporter,
 * vitest's `json` coverage reporter, nyc, c8). slopguard-typescript treats it
 * the way slopguard-swift treats an `.xcresult`: the single canonical
 * artifact coverage is read from, regardless of which runner produced it.
 */

export interface IstanbulLocation {
  line: number;
  column: number;
}

export interface IstanbulRange {
  start: IstanbulLocation;
  end: IstanbulLocation;
}

export interface IstanbulFnMeta {
  name: string;
  decl: IstanbulRange;
  loc: IstanbulRange;
}

export interface IstanbulFileCoverage {
  path: string;
  statementMap: Record<string, IstanbulRange>;
  fnMap: Record<string, IstanbulFnMeta>;
  branchMap: Record<string, unknown>;
  /** Statement hit counts, keyed by statementMap id. */
  s: Record<string, number>;
  /** Function hit counts, keyed by fnMap id. */
  f: Record<string, number>;
  /** Branch hit counts. */
  b: Record<string, number[]>;
}

export type IstanbulCoverageMap = Record<string, IstanbulFileCoverage>;

/**
 * Parse the contents of a `coverage-final.json`. Tolerates the nested
 * `{ "<path>": { "data": {...} } }` wrapper some istanbul versions emit.
 */
export function parseIstanbulJson(text: string): IstanbulCoverageMap {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const map: IstanbulCoverageMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value !== "object") continue;
    const candidate = unwrapData(value as Record<string, unknown>);
    if (isFileCoverage(candidate)) {
      map[key] = candidate as unknown as IstanbulFileCoverage;
    }
  }
  return map;
}

function unwrapData(value: Record<string, unknown>): Record<string, unknown> {
  if ("data" in value && value.data !== null && typeof value.data === "object" && !("statementMap" in value)) {
    return value.data as Record<string, unknown>;
  }
  return value;
}

function isFileCoverage(value: Record<string, unknown>): boolean {
  return (
    typeof value.path === "string" &&
    value.statementMap !== null &&
    typeof value.statementMap === "object" &&
    value.s !== null &&
    typeof value.s === "object"
  );
}
