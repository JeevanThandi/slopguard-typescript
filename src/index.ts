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
export {
  FileAnalyzer,
  parseSourceFile,
  scriptKindFor,
  ANALYZABLE_EXTENSIONS,
} from "./core/analysis/fileAnalyzer.js";
export {
  DirectoryAnalyzer,
  DEFAULT_EXCLUDE_GLOBS,
  defaultAnalysisOptions,
  relativize,
} from "./core/analysis/directoryAnalyzer.js";
export type { AnalysisOptions, SourceFileRef } from "./core/analysis/directoryAnalyzer.js";
export { globToRegExp, matchesAny } from "./core/analysis/glob.js";
export { CrapAggregator } from "./core/aggregation/crapAggregator.js";
export type { CoverageProvider } from "./core/aggregation/coverageProvider.js";
export {
  prettyReport,
  jsonReport,
  errorText,
  errorJSON,
} from "./core/formatting/crapReportFormatter.js";
export { prettyMutationReport, jsonMutationReport } from "./core/formatting/mutationReportFormatter.js";
export { MUTATION_OPERATORS, isMutationOperator, parseOperators } from "./core/mutation/operators.js";
export type { MutationOperator } from "./core/mutation/operators.js";
export {
  MUTATION_SCHEMA_VERSION,
  applyMutant,
  compareSites,
  mutantId,
  summarize,
} from "./core/mutation/models.js";
export type {
  MutantResult,
  MutantSite,
  MutantStatus,
  MutationReport,
  MutationSummary,
} from "./core/mutation/models.js";
export { MutantGenerator } from "./core/mutation/mutantGenerator.js";
export { COMMENT_ONLY, IGNORE_MARKER, isIgnored, parseIgnoreMarkers } from "./core/mutation/ignoreMarkers.js";
export type { IgnoreMap } from "./core/mutation/ignoreMarkers.js";
export { MutationPlanner, enclosingMethod } from "./core/mutation/mutationPlanner.js";
export type { PlannedMutant } from "./core/mutation/mutationPlanner.js";
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
  loadCoverageIndex,
} from "./coverage/analysisPipeline.js";
export type { CoverageSource } from "./coverage/analysisPipeline.js";
export { OutputTail } from "./coverage/outputTail.js";
export { CommandRunner, mutantTestArguments } from "./mutation/commandRunner.js";
export type { CommandOutcome, KillFn } from "./mutation/commandRunner.js";
export { WorkspaceGuard, SourceChangedError, guardDirectory } from "./mutation/workspaceGuard.js";
export type { GuardOptions } from "./mutation/workspaceGuard.js";
export {
  MutationPipeline,
  changedFileNote,
  classify,
  coverageExitNote,
  NOTE_ALL_SURVIVED,
  NOTE_NO_COVERAGE,
  SIGNAL_EXIT_CODES,
  TIMEOUT_GRACE_SECONDS,
} from "./mutation/mutationPipeline.js";
export type { MutationRunArgs, ProcessHooks } from "./mutation/mutationPipeline.js";
