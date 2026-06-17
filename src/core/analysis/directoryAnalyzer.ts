import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { SlopguardError } from "../errors.js";
import { FileReport } from "../models.js";
import { FileAnalyzer, scriptKindFor } from "./fileAnalyzer.js";
import { matchesAny } from "./glob.js";

/**
 * Options controlling how `DirectoryAnalyzer` enumerates files. Globs use
 * fnmatch-style semantics where `*` matches across path separators (so `*`
 * and `**` behave alike — "everything under node_modules").
 */
export interface AnalysisOptions {
  includeGlobs: string[];
  excludeGlobs: string[];
}

/**
 * Globs every analyze run filters out unless the caller explicitly opts in
 * via `--no-default-excludes`. Categories:
 *
 * - **Build / dependency dirs** — output of npm/pnpm/yarn, bundlers, and
 *   frameworks. Analyzing these is always wrong.
 * - **Generated code** — codegen output (GraphQL codegen, protobuf, minified
 *   bundles) produces branchy nonsense that swamps real signal.
 * - **Test / spec code** — `*.test.*` / `*.spec.*` plus the `__tests__` /
 *   `test(s)/` directory conventions. Test code's CRAP isn't user-facing
 *   risk; if you genuinely want to inspect test complexity, pass
 *   `--no-default-excludes`.
 */
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  // Build / dependency dirs
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.git/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/vendor/**",
  // Generated code
  "**/*.d.ts",
  "**/*.min.js",
  "**/*.generated.*",
  "**/__generated__/**",
  // Test code
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/test/**",
  "**/tests/**",
  "**/e2e/**",
  // Config files at any level — tooling config (vitest.config.ts, etc.)
  // is not product code.
  "**/*.config.*",
  // Reference fixtures used to benchmark the analyzer itself; deliberately
  // skipped from a top-level scan so they don't pollute dogfood numbers.
  // Pass an explicit `--path sample-apps/...` to analyze them on demand.
  "**/sample-apps/**",
];

export function defaultAnalysisOptions(): AnalysisOptions {
  return { includeGlobs: [], excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS] };
}

/** Walks a directory tree and analyzes every analyzable source file it finds. */
export class DirectoryAnalyzer {
  private readonly analyzer: FileAnalyzer;

  constructor(analyzer: FileAnalyzer = new FileAnalyzer()) {
    this.analyzer = analyzer;
  }

  /**
   * Returns one `FileReport` per analyzed file. The `path` on each report is
   * the path *relative to* `root` (forward-slash, no leading `./`).
   */
  async analyze(root: string, options: AnalysisOptions = defaultAnalysisOptions()): Promise<FileReport[]> {
    const { files, rootPrefix } = await this.resolveFileSet(root, options);
    const reports = await Promise.all(
      files.map((file) => this.analyzer.analyzeFile(file, relativize(file, rootPrefix)))
    );
    /* v8 ignore next -- the `0` tiebreaker can't fire: file paths in a listing are unique */
    return reports.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private async resolveFileSet(
    root: string,
    options: AnalysisOptions
  ): Promise<{ files: string[]; rootPrefix: string }> {
    const rootPath = path.resolve(root);
    let info;
    try {
      info = await stat(rootPath);
    } catch {
      throw SlopguardError.fileNotFound(rootPath);
    }
    if (info.isDirectory()) {
      return { files: await this.enumerate(rootPath, options), rootPrefix: rootPath };
    }
    return { files: [rootPath], rootPrefix: path.dirname(rootPath) };
  }

  private async enumerate(rootPath: string, options: AnalysisOptions): Promise<string[]> {
    const results: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        throw SlopguardError.unreadableFile(dir, String(error));
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue; // skip hidden files/dirs
        const absolute = path.join(dir, entry.name);
        const relative = relativize(absolute, rootPath);
        if (entry.isDirectory()) {
          if (!matchesAny(options.excludeGlobs, relative)) {
            await walk(absolute);
          }
          continue;
        }
        if (!entry.isFile()) continue; // symlinks are not followed
        if (this.shouldAnalyze(relative, options)) {
          results.push(absolute);
        }
      }
    };
    await walk(rootPath);
    return results;
  }

  private shouldAnalyze(relative: string, options: AnalysisOptions): boolean {
    if (scriptKindFor(relative) === null) return false;
    if (matchesAny(options.excludeGlobs, relative)) return false;
    if (options.includeGlobs.length > 0 && !matchesAny(options.includeGlobs, relative)) {
      return false;
    }
    return true;
  }
}

/** Forward-slash relative path of `absolute` under `root`. */
export function relativize(absolute: string, root: string): string {
  if (absolute === root) return path.basename(absolute);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  const rel = absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute;
  return rel.split(path.sep).join("/");
}
