import { describe, expect, it } from "vitest";
import { CoverageProvider } from "../src/core/aggregation/coverageProvider.js";
import { CrapAggregator } from "../src/core/aggregation/crapAggregator.js";
import { crapScore } from "../src/core/crap.js";
import { FileReport, makeMethodMetric, methodId } from "../src/core/models.js";

function fileReport(): FileReport {
  const simple = makeMethodMetric({
    name: "simple",
    qualifiedName: "Store.simple",
    typeName: "Store",
    kind: "method",
    file: "store.ts",
    startLine: 2,
    endLine: 4,
    complexity: 1,
    cognitiveComplexity: 0,
  });
  const gnarly = makeMethodMetric({
    name: "gnarly",
    qualifiedName: "Store.gnarly",
    typeName: "Store",
    kind: "method",
    file: "store.ts",
    startLine: 6,
    endLine: 30,
    complexity: 10,
    cognitiveComplexity: 12,
  });
  return {
    path: "store.ts",
    methods: [simple, gnarly],
    types: [
      {
        kind: "class",
        name: "Store",
        file: "store.ts",
        startLine: 1,
        endLine: 31,
        methodIDs: [methodId(simple), methodId(gnarly)],
        methodCount: 2,
        totalComplexity: 11,
        maxComplexity: 10,
        totalCognitiveComplexity: 12,
        maxCognitiveComplexity: 12,
      },
    ],
  };
}

const aggregator = new CrapAggregator();

describe("CrapAggregator", () => {
  it("treats missing coverage as 0% with coverageAvailable=false", () => {
    const report = aggregator.aggregate({
      fileReports: [fileReport()],
      sourceRoot: "/proj",
      coverageDataPath: null,
      coverage: null,
    });
    expect(report.coverageAvailable).toBe(false);
    expect(report.summary.weightedCoverage).toBeNull();
    const gnarly = report.methods.find((m) => m.name === "gnarly")!;
    expect(gnarly.coverage).toBe(0);
    expect(gnarly.crap).toBeCloseTo(crapScore(gnarly.weightedComplexity, 0));
  });

  it("joins method coverage from a provider", () => {
    const provider: CoverageProvider = {
      methodCoverage: (_path, line) => (line === 6 ? 80 : 100),
      fileCoverage: () => 90,
    };
    const report = aggregator.aggregate({
      fileReports: [fileReport()],
      sourceRoot: "/proj",
      coverageDataPath: "/proj/coverage/coverage-final.json",
      coverage: provider,
    });
    expect(report.coverageAvailable).toBe(true);
    const gnarly = report.methods.find((m) => m.name === "gnarly")!;
    expect(gnarly.coverage).toBe(80);
    expect(gnarly.crap).toBeCloseTo(crapScore(gnarly.weightedComplexity, 80));
  });

  it("falls back to file coverage when method coverage is unknown", () => {
    const provider: CoverageProvider = {
      methodCoverage: () => null,
      fileCoverage: () => 42,
    };
    const report = aggregator.aggregate({
      fileReports: [fileReport()],
      sourceRoot: "/proj",
      coverageDataPath: null,
      coverage: provider,
    });
    expect(report.methods[0]!.coverage).toBe(42);
  });

  it("sorts methods by crap descending and computes the summary", () => {
    const report = aggregator.aggregate({
      fileReports: [fileReport()],
      sourceRoot: "/proj",
      coverageDataPath: null,
      coverage: null,
    });
    expect(report.methods.map((m) => m.name)).toEqual(["gnarly", "simple"]);
    expect(report.summary.methodCount).toBe(2);
    expect(report.summary.fileCount).toBe(1);
    expect(report.summary.typeCount).toBe(1);
    expect(report.summary.maxCrap).toBeCloseTo(report.methods[0]!.crap);
    expect(report.summary.averageComplexity).toBeCloseTo(5.5);
  });

  it("aggregates types with the weighted-total formula", () => {
    const report = aggregator.aggregate({
      fileReports: [fileReport()],
      sourceRoot: "/proj",
      coverageDataPath: null,
      coverage: null,
    });
    const store = report.types[0]!;
    expect(store.name).toBe("Store");
    expect(store.weightedTotalComplexity).toBeCloseTo(Math.sqrt(11 * 12));
    expect(store.aggregatedCrap).toBeCloseTo(crapScore(Math.sqrt(11 * 12), store.weightedCoverage));
    expect(store.isCrappy).toBe(true);
  });

  it("flags crappiness against the threshold", () => {
    const lenient = aggregator.aggregate({
      fileReports: [fileReport()],
      sourceRoot: "/proj",
      coverageDataPath: null,
      coverage: null,
      threshold: 100000,
    });
    expect(lenient.methods.every((m) => !m.isCrappy)).toBe(true);
    expect(lenient.summary.crappyMethodCount).toBe(0);
  });

  it("always carries the schema-2 note first, then caller notes", () => {
    const report = aggregator.aggregate({
      fileReports: [],
      sourceRoot: "/proj",
      coverageDataPath: null,
      coverage: null,
      notes: ["custom note"],
    });
    expect(report.notes[0]).toContain("wCRAP");
    expect(report.notes[1]).toBe("custom note");
    expect(report.schemaVersion).toBe("2");
    expect(report.tool).toBe("slopguard-typescript");
  });

  it("handles an empty analysis", () => {
    const report = aggregator.aggregate({
      fileReports: [],
      sourceRoot: "/proj",
      coverageDataPath: null,
      coverage: null,
    });
    expect(report.summary.methodCount).toBe(0);
    expect(report.summary.averageCrap).toBe(0);
    expect(report.summary.maxCrap).toBe(0);
  });
});
