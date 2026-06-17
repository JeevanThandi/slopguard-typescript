import { describe, expect, it } from "vitest";
import { resolveProgressReporter } from "../src/cli/analyze.js";

describe("resolveProgressReporter", () => {
  it("defaults to normal phase markers", () => {
    expect(resolveProgressReporter({ verbose: false, quiet: false }).verbosity).toBe("normal");
  });

  it("maps --verbose to verbose", () => {
    expect(resolveProgressReporter({ verbose: true, quiet: false }).verbosity).toBe("verbose");
  });

  it("maps --quiet to silent", () => {
    expect(resolveProgressReporter({ verbose: false, quiet: true }).verbosity).toBe("silent");
  });

  it("lets --quiet win when both are passed", () => {
    expect(resolveProgressReporter({ verbose: true, quiet: true }).verbosity).toBe("silent");
  });
});
