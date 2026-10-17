import { describe, it, expect } from "vitest";
import { parseBenchmarkSummary } from "../main";
import { validateArchiveOutputSelectionToken } from "../e2e-archive-benchmark";
import {
  COMPATIBILITY_CASES,
  classifyTargetStatus,
  classifyTrendStatus,
  compareBenchmarkReports,
  compareMeasurementItem,
  hasArchiveLinkMetadata,
  medianAbsoluteDeviation,
  median as archiveIoMedian,
  parseArgs,
  parseCommandTemplate,
  parseOperationCommandTemplates,
  redactText,
  ratio as archiveIoRatio,
  runAlternatingExecutorPair,
  verifyBrowseListing,
} from "../../bench/archive-io/benchmark.mjs";

describe("parseBenchmarkSummary", () => {
  it("extracts the rating from the Tot: line", () => {
    const stdout = [
      "7-Zip (z) 26.01",
      "Compr   Decompr",
      "Avg:    4012   4099",
      "Tot:             4123   100   4150",
    ].join("\n");
    expect(parseBenchmarkSummary(stdout)).toBe("Rating: 4150");
  });

  it("returns null when there is no Tot line", () => {
    expect(parseBenchmarkSummary("Everything is Ok")).toBeNull();
  });

  it("handles CRLF output", () => {
    expect(parseBenchmarkSummary("Tot:   1   2   3333\r\n")).toBe(
      "Rating: 3333",
    );
  });
});

describe("archive I/O benchmark helpers", () => {
  it("uses deterministic median and ratio calculations", () => {
    expect(archiveIoMedian([30, 10, 20, 40, 50])).toBe(30);
    expect(archiveIoMedian([10, 20, 30, 40])).toBe(25);
    expect(archiveIoRatio(125, 100)).toBe(1.25);
    expect(archiveIoRatio(null, 100)).toBeNull();
  });

  it("requires JSON argv arrays for optional Zinnia adapters", () => {
    expect(parseCommandTemplate('["runner", "extract", "{archive}"]')).toEqual([
      "runner",
      "extract",
      "{archive}",
    ]);
    expect(() => parseCommandTemplate("runner extract")).toThrow(
      "must be a JSON argv array",
    );
    expect(() => parseCommandTemplate("[]")).toThrow("non-empty JSON array");
  });

  it("accepts operation-aware adapters without inventing omitted operations", () => {
    expect(
      parseOperationCommandTemplates(
        '{"browse":["runner","browse","{input}"],"conversion":["runner","convert","{archive}","{target}"]}',
      ),
    ).toEqual({
      browse: ["runner", "browse", "{input}"],
      conversion: ["runner", "convert", "{archive}", "{target}"],
    });
    expect(parseOperationCommandTemplates('["runner","extract"]')).toEqual({
      extract: ["runner", "extract"],
    });
    expect(() =>
      parseOperationCommandTemplates('{"unknown":["runner"]}'),
    ).toThrow("Unsupported Zinnia adapter operation");
  });

  it("supports release-scale operation selection", () => {
    const options = parseArgs([
      "--scale",
      "release",
      "--operations",
      "browse,conversion,batch",
      "--operation-formats",
      "zip,7z",
      "--operation-workloads",
      "bulk,small",
    ]);
    expect(options.scale).toBe("release");
    expect(options.operations).toEqual(["browse", "conversion", "batch"]);
    expect(options.operationFormats).toEqual(["zip", "7z"]);
    expect(options.operationWorkloads).toEqual(["bulk", "small"]);
  });

  it("enables compatibility rows explicitly without treating them as primary cases", () => {
    expect(parseArgs(["--compatibility"]).compatibility).toBe(true);
    expect(COMPATIBILITY_CASES.map((item) => item.name)).toEqual([
      "rar",
      "split",
      "encrypted",
      "link-bearing",
      "unsupported-filesystem",
      "custom-acl",
    ]);
    expect(COMPATIBILITY_CASES.slice(0, 4)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "fixture-required" }),
      ]),
    );
  });

  it("requires non-empty link metadata before link-bearing timing", () => {
    expect(
      hasArchiveLinkMetadata(
        "Path = hard.txt\nHard Link = real.txt\nAttributes = A\n",
      ),
    ).toBe(true);
    expect(
      hasArchiveLinkMetadata("Path = link.txt\nSymbolic Link = target.txt\n"),
    ).toBe(true);
    expect(
      hasArchiveLinkMetadata(
        "Path = hard.txt\nSize = 20\nPath = real.txt\nSize = 20\n",
      ),
    ).toBe(false);
  });

  it("preserves the absent output token used by create and conversion", () => {
    expect(validateArchiveOutputSelectionToken("absent")).toBe("absent");
    expect(validateArchiveOutputSelectionToken("a".repeat(64))).toBe(
      "a".repeat(64),
    );
    expect(() => validateArchiveOutputSelectionToken(undefined)).toThrow(
      /literal absent sentinel/,
    );
    expect(() => validateArchiveOutputSelectionToken("absent ")).toThrow(
      /literal absent sentinel/,
    );
  });

  it("calculates unscaled median absolute deviation", () => {
    expect(medianAbsoluteDeviation([10, 20, 30, 40, 50])).toBe(10);
    expect(medianAbsoluteDeviation([1, 1, 1])).toBe(0);
    expect(medianAbsoluteDeviation([])).toBeNull();
  });

  it("alternates asynchronous direct and candidate callbacks", async () => {
    const calls: string[] = [];
    const result = await runAlternatingExecutorPair({
      measuredIterations: 5,
      direct: ({ phase, iteration }) => {
        calls.push(`direct:${phase}:${iteration}`);
        return { durationMs: 100, code: 0 };
      },
      zinnia: ({ phase, iteration }) => {
        calls.push(`zinnia:${phase}:${iteration}`);
        return { durationMs: 125, code: 0 };
      },
    });
    expect(calls).toEqual([
      "direct:warmup:0",
      "zinnia:warmup:0",
      "direct:measured:0",
      "zinnia:measured:0",
      "zinnia:measured:1",
      "direct:measured:1",
      "direct:measured:2",
      "zinnia:measured:2",
      "zinnia:measured:3",
      "direct:measured:3",
      "direct:measured:4",
      "zinnia:measured:4",
    ]);
    expect(result.direct.measuredMs).toHaveLength(5);
    expect(result.zinnia?.measuredMs).toHaveLength(5);
    expect(result.ratioSamples).toEqual([1.25, 1.25, 1.25, 1.25, 1.25]);
  });

  it.each([
    ["undefined", undefined, "executor returned invalid result"],
    ["null", null, "executor returned invalid result"],
    ["a string", "not a result", "executor returned invalid result"],
    ["an array", [], "executor returned invalid result"],
    ["missing code", { durationMs: 10 }, "executor returned invalid code"],
    [
      "a non-numeric code",
      { code: "0", durationMs: 10 },
      "executor returned invalid code",
    ],
    [
      "a fractional code",
      { code: 0.5, durationMs: 10 },
      "executor returned invalid code",
    ],
    ["missing duration", { code: 0 }, "executor returned invalid durationMs"],
    [
      "a non-finite duration",
      { code: 0, durationMs: Infinity },
      "executor returned invalid durationMs",
    ],
    [
      "a negative duration",
      { code: 0, durationMs: -1 },
      "executor returned invalid durationMs",
    ],
  ])(
    "rejects malformed asynchronous executor result: %s",
    async (_label, invalidResult, errorMessage) => {
      const result = await runAlternatingExecutorPair({
        measuredIterations: 1,
        warmupIterations: 0,
        direct: () => ({ durationMs: 100, code: 0 }),
        zinnia: () => invalidResult,
      });
      expect(result.zinnia?.error).toBe(errorMessage);
      expect(result.zinnia?.measuredMs).toEqual([]);
      expect(result.ratioSamples).toEqual([]);
    },
  );

  it("rejects missing or corrupt browse listings", () => {
    const expectedManifest = [
      { path: "payload/hello.txt", bytes: 5, sha256: "unused" },
    ];
    expect(verifyBrowseListing("", expectedManifest)).toEqual({
      ok: false,
      reason: "archive listing is empty",
    });
    expect(verifyBrowseListing("   \n", expectedManifest)).toEqual({
      ok: false,
      reason: "archive listing is empty",
    });
    expect(
      verifyBrowseListing("Path = payload/other.txt\n", expectedManifest),
    ).toEqual({
      ok: false,
      reason: "archive listing misses payload/hello.txt",
    });
  });

  it("classifies target and trend independently", () => {
    expect(classifyTargetStatus(1.2, "bulk")).toBe("met");
    expect(classifyTargetStatus(1.3, "bulk")).toBe("missed");
    expect(classifyTargetStatus(null, "bulk")).toBe("not-applicable");
    expect(
      classifyTrendStatus({
        candidateRatio: 0.9,
        baselineRatio: 1,
        candidateRelativeMad: 0,
        baselineRelativeMad: 0,
      }),
    ).toBe("improved");
    expect(
      classifyTrendStatus({
        candidateRatio: 1.2,
        baselineRatio: 1,
        candidateRelativeMad: 0,
        baselineRelativeMad: 0,
      }),
    ).toBe("regressed");
    expect(
      classifyTrendStatus({
        candidateRatio: 1,
        baselineRatio: 1,
        candidateRelativeMad: 0.11,
        baselineRelativeMad: 0,
      }),
    ).toBe("noisy");
    expect(
      classifyTrendStatus({
        candidateRatio: 1,
        baselineRatio: null,
        baselineAvailable: false,
      }),
    ).toBe("baseline-unavailable");
  });

  it("compares report items without making timing a hard failure", () => {
    const item = {
      workload: "bulk",
      format: "zip",
      status: "measured",
      direct: {
        measuredMs: [100, 100, 100, 100, 100],
        medianMs: 100,
        verified: true,
        error: null,
      },
      zinnia: {
        measuredMs: [130, 130, 130, 130, 130],
        medianMs: 130,
        verified: true,
        error: null,
      },
    };
    const baseline = {
      ...item,
      zinnia: {
        ...item.zinnia,
        measuredMs: [100, 100, 100, 100, 100],
        medianMs: 100,
      },
    };
    const compared = compareMeasurementItem(item, baseline);
    expect(compared.targetStatus).toBe("missed");
    expect(compared.trendStatus).toBe("regressed");
    const report = compareBenchmarkReports(
      {
        schemaVersion: 2,
        candidateRevision: "head",
        cases: [item],
        operations: [],
        failures: [],
      },
      { cases: [baseline], operations: [], failures: [] },
    );
    expect(report.schemaVersion).toBe(3);
    expect(report.failures).toEqual([]);
    expect(report.cases[0].targetStatus).toBe("missed");
    expect(report.comparison.baselineAvailable).toBe(true);
    expect(report.comparison.baselineStatus).toBe("available");
  });

  it("marks a direct-only baseline as unavailable", () => {
    const item = {
      workload: "bulk",
      format: "zip",
      status: "measured",
      direct: {
        measuredMs: [100, 100, 100, 100, 100],
        medianMs: 100,
        verified: true,
      },
      zinnia: {
        measuredMs: [120, 120, 120, 120, 120],
        medianMs: 120,
        verified: true,
      },
    };
    const report = compareBenchmarkReports(
      { cases: [item], operations: [], failures: [] },
      {
        cases: [{ ...item, zinnia: null }],
        operations: [],
        failures: [],
      },
    );

    expect(report.base.available).toBe(false);
    expect(report.comparison.baselineAvailable).toBe(false);
    expect(report.comparison.baselineStatus).toBe("baseline-unavailable");
    expect(report.cases[0].trendStatus).toBe("baseline-unavailable");
  });

  it("keeps partial baseline matches per item", () => {
    const candidateItems = [
      {
        workload: "bulk",
        format: "zip",
        status: "measured",
        direct: { measuredMs: [100], medianMs: 100, verified: true },
        zinnia: { measuredMs: [120], medianMs: 120, verified: true },
      },
      {
        workload: "small",
        format: "zip",
        status: "measured",
        direct: { measuredMs: [100], medianMs: 100, verified: true },
        zinnia: { measuredMs: [120], medianMs: 120, verified: true },
      },
    ];
    const report = compareBenchmarkReports(
      { cases: candidateItems, operations: [], failures: [] },
      {
        cases: [
          {
            ...candidateItems[0],
            zinnia: { measuredMs: [120], medianMs: 120, verified: true },
          },
        ],
        operations: [],
        failures: [],
      },
    );

    expect(report.comparison.baselineAvailable).toBe(true);
    expect(report.cases[0].trendStatus).toBe("stable");
    expect(report.cases[1].trendStatus).toBe("baseline-unavailable");

    const mismatched = compareBenchmarkReports(
      { cases: [candidateItems[0]], operations: [], failures: [] },
      {
        cases: [
          {
            ...candidateItems[0],
            workload: "small",
            zinnia: { measuredMs: [120], medianMs: 120, verified: true },
          },
        ],
        operations: [],
        failures: [],
      },
    );
    expect(mismatched.comparison.baselineAvailable).toBe(false);
    expect(mismatched.comparison.baselineStatus).toBe("baseline-unavailable");
  });

  it("keeps compatibility timing outside primary target and trend rollups", () => {
    const report = compareBenchmarkReports({
      cases: [],
      operations: [],
      compatibilityMeasurements: [
        {
          name: "encrypted",
          status: "measured",
          direct: { measuredMs: [10], medianMs: 10, verified: true },
          zinnia: { measuredMs: [20], medianMs: 20, verified: true },
        },
      ],
      failures: [],
    });
    expect(report.timingFindings).toEqual([]);
    expect(report.compatibilityMeasurements).toHaveLength(1);
    expect(report.compatibilityMeasurements[0].targetStatus).toBeUndefined();
  });

  it("keeps unsupported capability rows explicit and non-blocking", () => {
    const report = compareBenchmarkReports({
      cases: [],
      operations: [],
      compatibilityMeasurements: [
        {
          name: "unsupported-filesystem",
          status: "not-available",
          note: "not-available: no provisioned filesystem",
          direct: null,
          zinnia: null,
        },
        {
          name: "custom-acl",
          status: "not-available",
          note: "not-available: no provisioned ACL fixture",
          direct: null,
          zinnia: null,
        },
      ],
      failures: [],
    });
    expect(
      report.compatibilityMeasurements.map(
        (item: { name: string; status: string }) => [item.name, item.status],
      ),
    ).toEqual([
      ["unsupported-filesystem", "not-available"],
      ["custom-acl", "not-available"],
    ]);
    expect(report.failures).toEqual([]);
    expect(report.timingFindings).toEqual([]);
  });

  it("fails missing candidate measurements while preserving baseline-unavailable trend", () => {
    const report = compareBenchmarkReports(
      {
        cases: [
          {
            workload: "small",
            format: "zip",
            status: "zinnia-unavailable",
            direct: {
              measuredMs: [10, 10, 10, 10, 10],
              medianMs: 10,
              verified: true,
            },
            zinnia: null,
          },
        ],
        operations: [],
        failures: [],
      },
      null,
    );
    expect(report.failures[0]).toContain("candidate measurement missing");
    expect(report.cases[0].trendStatus).toBe("baseline-unavailable");
  });

  it("redacts passwords and absolute paths", () => {
    expect(
      redactText("password=swordfish C:\\work\\fixture\\a.zip", [
        "C:\\work\\fixture",
      ]),
    ).toBe("password=<redacted> <path>\\a.zip");
  });
});
