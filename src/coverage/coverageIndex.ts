import path from "node:path";
import { CoverageProvider } from "../core/aggregation/coverageProvider.js";
import { IstanbulCoverageMap } from "./istanbul.js";

interface IndexedFile {
  path: string;
  basename: string;
  /** 1-based line → covered? Built from the statement map: a line is covered
   *  when at least one statement starting on it has a nonzero hit count. */
  lineHits: Map<number, boolean>;
  executableLines: number;
  coveredLines: number;
}

/**
 * Fast lookup over an istanbul coverage map. Built once after the test run,
 * then queried per method by `CrapAggregator`.
 *
 * Istanbul reports file paths as *absolute* paths (the machine's view of the
 * source tree). Our analyzer reports paths *relative* to the analysis root.
 * The caller is therefore expected to resolve a method's path back to an
 * absolute path (`root + relativePath`) before querying. We additionally keep
 * a basename map to fall back on when paths don't match exactly (CI checkouts
 * vs. local clones, symlinks, etc.).
 */
export class CoverageIndex implements CoverageProvider {
  private readonly filesByAbsolutePath = new Map<string, IndexedFile>();
  private readonly filesByBasename = new Map<string, IndexedFile[]>();

  readonly totalExecutableLines: number;
  readonly totalCoveredLines: number;

  constructor(coverageMap: IstanbulCoverageMap) {
    let totalExecutable = 0;
    let totalCovered = 0;
    for (const file of Object.values(coverageMap)) {
      const lineHits = new Map<number, boolean>();
      for (const [id, range] of Object.entries(file.statementMap)) {
        const line = range.start.line;
        const hit = (file.s[id] ?? 0) > 0;
        lineHits.set(line, (lineHits.get(line) ?? false) || hit);
      }
      let covered = 0;
      for (const hit of lineHits.values()) if (hit) covered += 1;
      const indexed: IndexedFile = {
        path: file.path,
        basename: path.basename(file.path),
        lineHits,
        executableLines: lineHits.size,
        coveredLines: covered,
      };
      totalExecutable += indexed.executableLines;
      totalCovered += indexed.coveredLines;
      this.filesByAbsolutePath.set(file.path, indexed);
      const siblings = this.filesByBasename.get(indexed.basename) ?? [];
      siblings.push(indexed);
      this.filesByBasename.set(indexed.basename, siblings);
    }
    this.totalExecutableLines = totalExecutable;
    this.totalCoveredLines = totalCovered;
  }

  get fileCount(): number {
    return this.filesByAbsolutePath.size;
  }

  /**
   * Method-level line coverage as a percentage in [0, 100], or null if the
   * file is unknown or no executable line falls inside [line, endLine]. The
   * caller decides whether null falls back to file-level coverage or 0%.
   */
  methodCoverage(absolutePath: string, line: number, endLine: number): number | null {
    const file = this.lookupFile(absolutePath);
    if (!file) return null;
    let executable = 0;
    let covered = 0;
    for (const [l, hit] of file.lineHits) {
      if (l < line || l > endLine) continue;
      executable += 1;
      if (hit) covered += 1;
    }
    if (executable === 0) return null;
    return (covered / executable) * 100;
  }

  /** File-level coverage as a percentage in [0, 100], or null if unknown. */
  fileCoverage(absolutePath: string): number | null {
    const file = this.lookupFile(absolutePath);
    if (!file) return null;
    if (file.executableLines === 0) return null;
    return (file.coveredLines / file.executableLines) * 100;
  }

  private lookupFile(absolutePath: string): IndexedFile | null {
    const direct = this.filesByAbsolutePath.get(absolutePath);
    if (direct) return direct;
    const candidates = this.filesByBasename.get(path.basename(absolutePath)) ?? [];
    if (candidates.length === 1) return candidates[0]!;
    // Multiple files with the same basename — pick the one whose path shares
    // the longest suffix with the query path. This handles common CI cases
    // (`/home/runner/work/...` vs `/Users/dev/...`) without false positives
    // when there are genuinely-distinct files of the same name.
    let best: IndexedFile | null = null;
    let bestOverlap = 0;
    for (const candidate of candidates) {
      const overlap = sharedSuffixLength(absolutePath, candidate.path);
      if (overlap > bestOverlap) {
        best = candidate;
        bestOverlap = overlap;
      }
    }
    return best;
  }
}

function sharedSuffixLength(a: string, b: string): number {
  let count = 0;
  let ai = a.length - 1;
  let bi = b.length - 1;
  while (ai >= 0 && bi >= 0 && a[ai] === b[bi]) {
    count += 1;
    ai -= 1;
    bi -= 1;
  }
  return count;
}
