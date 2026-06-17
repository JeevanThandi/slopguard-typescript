/**
 * Sink for human-readable progress chatter from long-running operations
 * (directory walks, test runs, coverage parsing). Always goes to a side
 * channel so it can't pollute the main result stream — the CLI binds it to
 * stderr so `--json` consumers piping into `jq` stay clean.
 */

export type Verbosity = "silent" | "normal" | "verbose";

const ignore = (): void => {};

export class ProgressReporter {
  readonly verbosity: Verbosity;
  private readonly messageSink: (line: string) => void;
  private readonly rawSink: (chunk: Buffer | string) => void;

  constructor(
    verbosity: Verbosity,
    messageSink: (line: string) => void,
    rawSink: (chunk: Buffer | string) => void
  ) {
    this.verbosity = verbosity;
    this.messageSink = messageSink;
    this.rawSink = rawSink;
  }

  /** A reporter that swallows everything. Default for library callers. */
  static readonly silent = new ProgressReporter("silent", ignore, ignore);

  /**
   * A reporter wired to `process.stderr`. The CLI's default. Gating is baked
   * into the sinks: a non-verbose reporter gets an `ignore` raw sink, so
   * `phase`/`raw` can stay branch-free and always just call their sink.
   */
  static stderr(verbosity: Verbosity = "normal"): ProgressReporter {
    return new ProgressReporter(
      verbosity,
      (line) => process.stderr.write(line + "\n"),
      verbosity === "verbose" ? (chunk) => process.stderr.write(chunk) : ignore
    );
  }

  /**
   * Emit a phase marker. Output is prefixed with `slopguard: ` so it's
   * distinguishable from test-runner chatter when both share stderr. The
   * silent reporter's sink discards it.
   */
  phase(message: string): void {
    this.messageSink(`slopguard: ${message}`);
  }

  /**
   * Pass raw subprocess bytes through verbatim. Only the verbose reporter has
   * a sink that writes; every other reporter discards.
   */
  raw(chunk: Buffer | string): void {
    this.rawSink(chunk);
  }

  get isVerbose(): boolean {
    return this.verbosity === "verbose";
  }
}
