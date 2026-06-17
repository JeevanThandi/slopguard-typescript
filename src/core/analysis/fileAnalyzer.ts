import { readFile } from "node:fs/promises";
import ts from "typescript";
import { SlopguardError } from "../errors.js";
import { FileReport } from "../models.js";
import { ComplexityVisitor } from "./complexityVisitor.js";

/** File extensions the analyzer accepts, mapped to TypeScript script kinds. */
export const ANALYZABLE_EXTENSIONS: ReadonlyMap<string, ts.ScriptKind> = new Map([
  [".ts", ts.ScriptKind.TS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".js", ts.ScriptKind.JS],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
]);

export function scriptKindFor(path: string): ts.ScriptKind | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return ANALYZABLE_EXTENSIONS.get(path.slice(dot).toLowerCase()) ?? null;
}

/**
 * Parses one TypeScript/JavaScript source file and produces a `FileReport`.
 * Stateless — safe to call concurrently from `DirectoryAnalyzer`.
 */
export class FileAnalyzer {
  /**
   * Analyze a file on disk. Reads UTF-8 source, parses with the TypeScript
   * compiler, walks with `ComplexityVisitor`, and returns the result.
   *
   * @param path Absolute path of the source file.
   * @param reportedPath Path to record on the resulting `FileReport`
   *   (typically relative to the analysis root). Defaults to `path`.
   */
  async analyzeFile(path: string, reportedPath?: string): Promise<FileReport> {
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      throw SlopguardError.unreadableFile(path, String(error));
    }
    return this.analyzeSource(source, reportedPath ?? path);
  }

  /**
   * Analyze a source string directly. Useful for tests and any caller that
   * already has the source in memory.
   */
  analyzeSource(source: string, reportedPath: string): FileReport {
    const scriptKind = scriptKindFor(reportedPath) ?? ts.ScriptKind.TS;
    // setParentNodes=true: the visitor relies on .parent for else-if chain
    // detection, boolean-run collapse, and binding-name resolution.
    const sourceFile = ts.createSourceFile(
      reportedPath,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      scriptKind
    );
    const visitor = new ComplexityVisitor(reportedPath, sourceFile);
    visitor.walk();
    return { path: reportedPath, methods: visitor.methods, types: visitor.types };
  }
}
