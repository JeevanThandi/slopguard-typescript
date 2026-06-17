import { describe, expect, it, vi } from "vitest";
import { errorEnvelope, SlopguardError } from "../src/core/errors.js";
import { ProgressReporter } from "../src/core/progressReporter.js";

describe("SlopguardError", () => {
  it("carries stable codes and rendered messages", () => {
    expect(SlopguardError.fileNotFound("/x").code).toBe("file_not_found");
    expect(SlopguardError.fileNotFound("/x").message).toBe("File not found: /x");
    expect(SlopguardError.runnerAmbiguous(["vitest", "jest"]).message).toContain("--runner");
    expect(SlopguardError.testRunFailed(1, "boom").message).toContain("exit 1");
    expect(SlopguardError.invalidArgument("--threshold", "nope").code).toBe("invalid_argument");
  });

  it("renders [code] message via toString", () => {
    expect(String(SlopguardError.unsupported("x"))).toContain("[unsupported] Unsupported: x");
  });

  it("distinguishes the two coverage-missing reasons", () => {
    const noTests = SlopguardError.coverageDataMissing({ kind: "no_tests_detected" });
    expect(noTests.message).toContain("No tests were detected");
    const notGathered = SlopguardError.coverageDataMissing({
      kind: "coverage_not_gathered",
      testCount: 7,
    });
    expect(notGathered.message).toContain("7 test(s) ran");
    const unknown = SlopguardError.coverageDataMissing({
      kind: "coverage_not_gathered",
      testCount: null,
    });
    expect(unknown.message).toContain("tests appear to have run");
  });
});

describe("errorEnvelope", () => {
  it("wraps SlopguardError with its code", () => {
    expect(errorEnvelope(SlopguardError.notADirectory("/y"))).toEqual({
      code: "not_a_directory",
      message: "Not a directory: /y",
    });
  });

  it("wraps unknown errors as internal_error", () => {
    expect(errorEnvelope(new Error("boom")).code).toBe("internal_error");
  });
});

describe("ProgressReporter", () => {
  function capture(verbosity: "silent" | "normal" | "verbose") {
    const lines: string[] = [];
    const raw: string[] = [];
    const reporter = new ProgressReporter(
      verbosity,
      (l) => lines.push(l),
      (c) => raw.push(String(c))
    );
    return { reporter, lines, raw };
  }

  it("prefixes phase markers with slopguard:", () => {
    const { reporter, lines } = capture("normal");
    reporter.phase("running tests");
    expect(lines).toEqual(["slopguard: running tests"]);
  });

  it("silences everything via the silent factory", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => (writes.push(String(c)), true));
    try {
      ProgressReporter.silent.phase("x");
      ProgressReporter.silent.raw("y");
      expect(writes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("passes raw chunks only when the stderr reporter is verbose", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => (writes.push(String(c)), true));
    try {
      ProgressReporter.stderr("normal").raw("chunk");
      expect(writes).toEqual([]);
      expect(ProgressReporter.stderr("normal").isVerbose).toBe(false);

      ProgressReporter.stderr("verbose").raw("chunk");
      expect(writes).toEqual(["chunk"]);
      expect(ProgressReporter.stderr("verbose").isVerbose).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
