/** Public library surface — everything the CLI uses is exported here. */
export { crapScore, aggregateCrap, DEFAULT_CRAP_THRESHOLD } from "./core/crap.js";
export type { CrapAggregate } from "./core/crap.js";
export * from "./core/models.js";
export { SlopguardError, errorEnvelope } from "./core/errors.js";
export type { CoverageMissingReason, SlopguardErrorCode, SlopguardErrorEnvelope } from "./core/errors.js";
export { ProgressReporter } from "./core/progressReporter.js";
export type { Verbosity } from "./core/progressReporter.js";
export { SlopguardVersion } from "./core/version.js";
export { ComplexityVisitor } from "./core/analysis/complexityVisitor.js";
export { FileAnalyzer, scriptKindFor, ANALYZABLE_EXTENSIONS } from "./core/analysis/fileAnalyzer.js";
export {
  DirectoryAnalyzer,
  DEFAULT_EXCLUDE_GLOBS,
  defaultAnalysisOptions,
  relativize,
} from "./core/analysis/directoryAnalyzer.js";
export type { AnalysisOptions } from "./core/analysis/directoryAnalyzer.js";
export { globToRegExp, matchesAny } from "./core/analysis/glob.js";
export { CrapAggregator } from "./core/aggregation/crapAggregator.js";
export type { CoverageProvider } from "./core/aggregation/coverageProvider.js";
export {
  prettyReport,
  jsonReport,
  errorText,
  errorJSON,
} from "./core/formatting/crapReportFormatter.js";
export { CoverageIndex } from "./coverage/coverageIndex.js";
export { parseIstanbulJson } from "./coverage/istanbul.js";
export type { IstanbulCoverageMap, IstanbulFileCoverage } from "./coverage/istanbul.js";
export { discoverProjectRoot } from "./coverage/projectRootDiscovery.js";
export {
  detectRunner,
  detectCandidates,
  coverageArguments,
  runnerBinary,
  SUPPORTED_RUNNERS,
} from "./coverage/runnerDetection.js";
export type { RunnerKind } from "./coverage/runnerDetection.js";
export { TestRunner } from "./coverage/testRunner.js";
export type { TestRunOutcome } from "./coverage/testRunner.js";
export {
  AnalysisPipeline,
  coverageSourceFromFlags,
  expandTilde,
} from "./coverage/analysisPipeline.js";
export type { CoverageSource } from "./coverage/analysisPipeline.js";
