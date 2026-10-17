import {
  COMPATIBILITY_CASES,
  FORMATS,
  MEASURED_ITERATIONS,
  OPERATIONS,
  WARMUP_ITERATIONS,
  WORKLOADS,
  classifyTrendStatus,
  median,
  redactText,
  ratio,
  relativeMedianAbsoluteDeviation,
  ratioSamples,
} from "../bench/archive-io/benchmark.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const RELEASE_OPERATION_FORMATS = Object.freeze(["zip", "7z", "tar"]);

export const RELEASE_BENCHMARK_INVENTORY = Object.freeze({
  scale: "release",
  formats: Object.freeze(Object.keys(FORMATS)),
  workloads: Object.freeze(Object.keys(WORKLOADS)),
  operations: Object.freeze(OPERATIONS.slice()),
  operationFormats: RELEASE_OPERATION_FORMATS,
  operationWorkloads: Object.freeze(Object.keys(WORKLOADS)),
  compatibility: true,
});

export function benchmarkInventoryFromOptions(options) {
  return {
    scale: options.scale,
    formats: [...options.formats],
    workloads: [...options.workloads],
    operations: [...options.operations],
    operationFormats: [...options.operationFormats],
    operationWorkloads: [...options.operationWorkloads],
    compatibility: Boolean(options.compatibility),
  };
}

export function assertReleaseBenchmarkInventory(inventory) {
  if (!inventoriesMatch(inventory, RELEASE_BENCHMARK_INVENTORY)) {
    throw new Error(
      "Archive benchmark promotion requires the complete release-scale formats, workloads, operations, and compatibility inventory.",
    );
  }
}

const DEFAULT_ABORT_SETTLE_TIMEOUT_MS = 30_000;

function measurementRows(report) {
  return [...(report?.cases ?? []), ...(report?.operations ?? [])].filter(
    (row) => row.status !== "not-applicable",
  );
}

function canonicalStringList(value, field) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`Archive benchmark inventory ${field} is invalid.`);
  }
  const values = [...value].sort();
  if (new Set(values).size !== values.length) {
    throw new Error(
      `Archive benchmark inventory ${field} contains duplicates.`,
    );
  }
  return values;
}

function inventoriesMatch(actual, expected) {
  if (!actual || typeof actual !== "object") return false;
  if (actual.scale !== expected.scale) return false;
  if (actual.compatibility !== expected.compatibility) return false;
  return [
    "formats",
    "workloads",
    "operations",
    "operationFormats",
    "operationWorkloads",
  ].every((field) => {
    try {
      return (
        JSON.stringify(canonicalStringList(actual[field], field)) ===
        JSON.stringify(canonicalStringList(expected[field], field))
      );
    } catch {
      return false;
    }
  });
}

function expectedInventoryRows(expectedInventory) {
  const cases = new Map();
  for (const workload of expectedInventory.workloads) {
    for (const format of expectedInventory.formats) {
      if (!FORMATS[format] || !WORKLOADS[workload]) {
        throw new Error(
          `Archive benchmark inventory contains unsupported case ${workload}/${format}.`,
        );
      }
      cases.set(`${workload}/${format}`, {
        workload,
        format,
        status:
          FORMATS[format].directory || workload === "bulk"
            ? "measured"
            : "not-applicable",
        compatibility: FORMATS[format].compatibility,
      });
    }
  }

  const operations = new Map();
  for (const workload of expectedInventory.operationWorkloads) {
    for (const format of expectedInventory.operationFormats) {
      if (!FORMATS[format] || !WORKLOADS[workload]) {
        throw new Error(
          `Archive benchmark inventory contains unsupported operation case ${workload}/${format}.`,
        );
      }
      for (const operation of expectedInventory.operations) {
        if (!OPERATIONS.includes(operation)) {
          throw new Error(
            `Archive benchmark inventory contains unsupported operation ${operation}.`,
          );
        }
        const applicable =
          (FORMATS[format].directory || workload === "bulk") &&
          (FORMATS[format].directory ||
            ["browse", "test", "extract"].includes(operation));
        const compatibility =
          operation === "conversion"
            ? `${format} -> ${format === "7z" ? "zip" : "7z"}`
            : operation === "batch"
              ? "aggregate sequence"
              : FORMATS[format].compatibility;
        operations.set(`${operation}/${workload}/${format}`, {
          operation,
          workload,
          format,
          status: applicable ? "measured" : "not-applicable",
          compatibility,
        });
      }
    }
  }
  return { cases, operations };
}

function exactRows(rows, expected, keyFor, label) {
  if (!Array.isArray(rows)) {
    throw new Error(`Archive benchmark ${label} inventory is missing.`);
  }
  const actual = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (actual.has(key)) {
      throw new Error(
        `Archive benchmark ${label} inventory has duplicate row ${key}.`,
      );
    }
    actual.set(key, row);
  }
  const missing = [...expected.keys()].filter((key) => !actual.has(key));
  const extra = [...actual.keys()].filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Archive benchmark ${label} inventory differs; missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}.`,
    );
  }
  return actual;
}

function validateMeasurementRow(row, expected, label, warmupIterations) {
  const key = expected.operation
    ? `${expected.operation}/${expected.workload}/${expected.format}`
    : `${expected.workload}/${expected.format}`;
  if (
    row.workload !== expected.workload ||
    row.format !== expected.format ||
    row.operation !== expected.operation ||
    row.compatibility !== expected.compatibility
  ) {
    throw new Error(`Archive benchmark ${label} row ${key} is inconsistent.`);
  }
  if (row.status !== expected.status) {
    throw new Error(
      `Archive benchmark ${label} row ${key} has status ${row.status ?? "missing"}; expected ${expected.status}.`,
    );
  }
  if (expected.status === "not-applicable") {
    if (row.direct != null || row.zinnia != null) {
      throw new Error(
        `Archive benchmark ${label} not-applicable row ${key} includes measurements.`,
      );
    }
    return;
  }
  if (!completeMeasurementRow(row, warmupIterations)) {
    throw new Error(
      `Archive benchmark ${label} row ${key} lacks complete, consistent direct and Zinnia measurements.`,
    );
  }
  if (row.zinniaAvailable !== true) {
    throw new Error(
      `Archive benchmark ${label} row ${key} is measured but Zinnia is marked unavailable.`,
    );
  }
}

function validateCompatibilityRows(report, expectedInventory, label) {
  const expectedNames = expectedInventory.compatibility
    ? COMPATIBILITY_CASES.map(({ name }) => name)
    : [];
  const rows = report.compatibilityMeasurements;
  if (!Array.isArray(rows)) {
    throw new Error(
      `Archive benchmark ${label} compatibility inventory is missing.`,
    );
  }
  const rowsByName = new Map();
  for (const row of rows) {
    if (typeof row?.name !== "string" || rowsByName.has(row.name)) {
      throw new Error(
        `Archive benchmark ${label} compatibility inventory has a missing or duplicate row name.`,
      );
    }
    rowsByName.set(row.name, row);
  }
  const expected = new Set(expectedNames);
  const missing = expectedNames.filter((name) => !rowsByName.has(name));
  const extra = [...rowsByName.keys()].filter((name) => !expected.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Archive benchmark ${label} compatibility inventory differs; missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}.`,
    );
  }
  for (const { name } of COMPATIBILITY_CASES) {
    if (!expectedInventory.compatibility) break;
    const row = rowsByName.get(name);
    if (row.primary !== false) {
      throw new Error(
        `Archive benchmark ${label} compatibility row ${name} is incorrectly marked primary.`,
      );
    }
    const hostGated = name === "link-bearing";
    const expectedUnavailable =
      name === "unsupported-filesystem" || name === "custom-acl";
    if (expectedUnavailable || (hostGated && row.status === "not-available")) {
      if (
        row.status !== "not-available" ||
        row.direct != null ||
        row.zinnia != null ||
        row.required !== false ||
        row.zinniaAvailable !== false ||
        typeof row.note !== "string" ||
        !row.note.startsWith("not-available:")
      ) {
        throw new Error(
          `Archive benchmark ${label} compatibility row ${name} has inconsistent not-available status.`,
        );
      }
      continue;
    }
    const requiredWarmupIterations =
      expectedInventory.scale === "release" ? WARMUP_ITERATIONS : null;
    if (
      !completeMeasurementRow(row, requiredWarmupIterations) ||
      row.zinniaAvailable !== true
    ) {
      throw new Error(
        `Archive benchmark ${label} compatibility row ${name} lacks complete measurements.`,
      );
    }
  }
}

function validateReportInventory(
  report,
  expectedInventory,
  label,
  { requireRequestedInventory = false } = {},
) {
  if (expectedInventory.scale === "release") {
    if (report?.schemaVersion !== 3) {
      throw new Error(
        `Archive benchmark ${label} schema version is ${report?.schemaVersion ?? "missing"}; expected release schema 3.`,
      );
    }
    if (report?.protocol?.alternatingOrder !== true) {
      throw new Error(
        `Archive benchmark ${label} did not use alternating measurement order.`,
      );
    }
  }
  if (report?.protocol?.fixtureScale !== expectedInventory.scale) {
    throw new Error(
      `Archive benchmark ${label} fixture scale is ${report?.protocol?.fixtureScale ?? "missing"}; expected ${expectedInventory.scale}.`,
    );
  }
  if (
    report.protocol.warmupIterations !== WARMUP_ITERATIONS ||
    report.protocol.measuredIterations !== MEASURED_ITERATIONS
  ) {
    throw new Error(
      `Archive benchmark ${label} measurement protocol is inconsistent.`,
    );
  }
  if (requireRequestedInventory && !report.requestedInventory) {
    throw new Error(
      `Archive benchmark ${label} requested inventory is missing.`,
    );
  }
  if (
    report.requestedInventory &&
    !inventoriesMatch(report.requestedInventory, expectedInventory)
  ) {
    throw new Error(
      `Archive benchmark ${label} requested inventory is inconsistent.`,
    );
  }
  const expectedRows = expectedInventoryRows(expectedInventory);
  const requiredWarmupIterations =
    expectedInventory.scale === "release" ? WARMUP_ITERATIONS : null;
  const cases = exactRows(
    report.cases,
    expectedRows.cases,
    (row) => `${row?.workload ?? "?"}/${row?.format ?? "?"}`,
    `${label} case`,
  );
  const operations = exactRows(
    report.operations,
    expectedRows.operations,
    (row) =>
      `${row?.operation ?? "?"}/${row?.workload ?? "?"}/${row?.format ?? "?"}`,
    `${label} operation`,
  );
  for (const [key, expected] of expectedRows.cases) {
    validateMeasurementRow(
      cases.get(key),
      expected,
      "case",
      requiredWarmupIterations,
    );
  }
  for (const [key, expected] of expectedRows.operations) {
    validateMeasurementRow(
      operations.get(key),
      expected,
      "operation",
      requiredWarmupIterations,
    );
  }
  validateCompatibilityRows(report, expectedInventory, label);
}

function completeMeasurement(measurement, warmupIterations = null) {
  if (
    measurement?.verified === true &&
    (warmupIterations === null ||
      (Array.isArray(measurement.warmupMs) &&
        measurement.warmupMs.length === warmupIterations &&
        measurement.warmupMs.every(
          (value) => Number.isFinite(value) && value >= 0,
        ))) &&
    Number.isFinite(measurement.medianMs) &&
    measurement.medianMs > 0 &&
    Array.isArray(measurement.measuredMs) &&
    measurement.measuredMs.length === MEASURED_ITERATIONS &&
    measurement.measuredMs.every((value) => Number.isFinite(value) && value > 0)
  ) {
    return median(measurement.measuredMs) === measurement.medianMs;
  }
  return false;
}

function completeMeasurementRow(row, warmupIterations = null) {
  if (
    row?.status !== "measured" ||
    !completeMeasurement(row.direct, warmupIterations) ||
    !completeMeasurement(row.zinnia, warmupIterations)
  ) {
    return false;
  }
  const expectedRatios = ratioSamples(
    row.zinnia.measuredMs,
    row.direct.measuredMs,
  );
  return (
    expectedRatios.length === MEASURED_ITERATIONS &&
    Array.isArray(row.ratioSamples) &&
    row.ratioSamples.length === expectedRatios.length &&
    row.ratioSamples.every((value, index) => value === expectedRatios[index])
  );
}

export function pinBaselineCheckoutRevision(resolveHeadRevision) {
  if (typeof resolveHeadRevision !== "function") {
    throw new Error("Baseline checkout requires a HEAD revision resolver.");
  }
  const revision = resolveHeadRevision();
  if (
    typeof revision !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision)
  ) {
    throw new Error(
      "Baseline worktree HEAD did not resolve to an immutable commit SHA.",
    );
  }
  return revision.toLowerCase();
}

export function assertBaselineReport(
  report,
  expectedRevision,
  expectedInventory = RELEASE_BENCHMARK_INVENTORY,
) {
  const revision = report?.candidate?.revision ?? report?.candidateRevision;
  if (revision !== expectedRevision) {
    throw new Error(
      `Baseline archive benchmark revision ${revision ?? "missing"} does not match accepted beta ${expectedRevision}.`,
    );
  }
  if (!Array.isArray(report?.failures) || report.failures.length > 0) {
    throw new Error("Baseline archive benchmark report has failures.");
  }
  validateReportInventory(report, expectedInventory, "baseline");
}

export function assertComparedBaseline(
  report,
  expectedRevision,
  expectedCandidateRevision,
  expectedInventory = RELEASE_BENCHMARK_INVENTORY,
) {
  if (
    typeof expectedCandidateRevision !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(expectedCandidateRevision)
  ) {
    throw new Error(
      "Archive benchmark comparison requires the expected candidate checkout SHA.",
    );
  }
  const reportedCandidateRevisions = [
    report?.candidate?.revision,
    report?.candidateRevision,
  ].filter((revision) => revision != null);
  if (
    reportedCandidateRevisions.length === 0 ||
    reportedCandidateRevisions.some(
      (revision) =>
        typeof revision !== "string" ||
        revision.toLowerCase() !== expectedCandidateRevision.toLowerCase(),
    )
  ) {
    throw new Error(
      `Archive benchmark candidate revision does not match expected checkout ${expectedCandidateRevision}.`,
    );
  }
  if (report?.base?.revision !== expectedRevision) {
    throw new Error(
      `Archive benchmark comparison revision does not match accepted beta ${expectedRevision}.`,
    );
  }
  validateReportInventory(report, expectedInventory, "candidate", {
    requireRequestedInventory: true,
  });
  const rows = measurementRows(report);
  const requiredWarmupIterations =
    expectedInventory.scale === "release" ? WARMUP_ITERATIONS : null;
  if (
    !Array.isArray(report?.failures) ||
    report.failures.length > 0 ||
    report?.base?.available !== true ||
    report?.comparison?.baselineAvailable !== true ||
    report?.comparison?.baselineStatus !== "available" ||
    rows.length === 0 ||
    rows.some((row) => {
      if (
        !completeMeasurementRow(row, requiredWarmupIterations) ||
        !Number.isFinite(row.candidateRatio) ||
        row.candidateRatio <= 0 ||
        !Number.isFinite(row.baselineRatio) ||
        row.baselineRatio <= 0 ||
        !Number.isFinite(row.candidateRelativeMad) ||
        row.candidateRelativeMad < 0 ||
        !Number.isFinite(row.baselineRelativeMad) ||
        row.baselineRelativeMad < 0
      ) {
        return true;
      }
      const measuredCandidateRatio =
        ratio(row.zinnia.medianMs, row.direct.medianMs) ??
        median(row.ratioSamples);
      const measuredCandidateRelativeMad = relativeMedianAbsoluteDeviation(
        row.ratioSamples,
      );
      const measuredTrendStatus = classifyTrendStatus({
        candidateRatio: measuredCandidateRatio,
        baselineRatio: row.baselineRatio,
        candidateRelativeMad: measuredCandidateRelativeMad,
        baselineRelativeMad: row.baselineRelativeMad,
        baselineAvailable: true,
      });
      return (
        row.candidateRatio !== measuredCandidateRatio ||
        row.candidateRelativeMad !== measuredCandidateRelativeMad ||
        row.trendStatus !== measuredTrendStatus
      );
    })
  ) {
    throw new Error(
      "Archive benchmark has no complete comparable accepted-beta baseline.",
    );
  }
}

export function writeFailureArtifacts(
  outputDirectory,
  { stage, error, severity = "error", metadata = {} },
) {
  const outputDir = resolve(outputDirectory);
  const message = redactText(
    error instanceof Error ? error.message : String(error),
  );
  const detail = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    severity,
    stage,
    message,
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    metadata: Object.fromEntries(
      Object.entries(metadata).filter(
        ([key, value]) =>
          [
            "candidateRef",
            "candidateRevision",
            "expectedCandidateRevision",
            "baselineRef",
            "baselineRevision",
            "role",
          ].includes(key) &&
          (typeof value === "string" || value == null),
      ),
    ),
  };
  mkdirSync(outputDir, { recursive: true });
  const jsonPath = join(outputDir, "archive-io-failure.json");
  const markdownPath = join(outputDir, "archive-io-failure.md");
  const logPath = join(outputDir, "archive-io-failure.log");
  writeFileSync(jsonPath, `${JSON.stringify(detail, null, 2)}\n`);
  writeFileSync(
    markdownPath,
    [
      "# Archive I/O benchmark failure",
      "",
      `- Stage: ${stage}`,
      `- Severity: ${severity}`,
      `- Time: ${detail.generatedAt}`,
      `- Host: ${detail.host.platform}/${detail.host.arch}`,
      `- Error: ${message}`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    logPath,
    `${detail.generatedAt} [${stage}] ${severity.toUpperCase()}: ${message}\n`,
  );
  return { jsonPath, markdownPath, logPath };
}

export async function withTimeout(
  promise,
  timeoutMs,
  onTimeout,
  settleTimeoutMs = DEFAULT_ABORT_SETTLE_TIMEOUT_MS,
) {
  const deadlineAt = performance.now() + timeoutMs;
  const settle = (kind, value) =>
    performance.now() >= deadlineAt
      ? { kind: "timeout" }
      : { kind, [kind === "success" ? "value" : "error"]: value };
  const operation = Promise.resolve(promise).then(
    (value) => settle("success", value),
    (error) => settle("failure", error),
  );
  let timeout;
  const deadline = new Promise((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const outcome = await Promise.race([operation, deadline]);
  clearTimeout(timeout);
  if (outcome.kind === "success") return outcome.value;
  if (outcome.kind === "failure") throw outcome.error;

  const error = new Error(
    `Archive benchmark exceeded its ${timeoutMs}ms run timeout.`,
  );
  let cleanupError;
  try {
    await onTimeout?.(error);
  } catch (failure) {
    cleanupError = failure;
  }
  let settleTimeout;
  const settled = await Promise.race([
    operation.then(() => true),
    new Promise((resolve) => {
      settleTimeout = setTimeout(() => resolve(false), settleTimeoutMs);
    }),
  ]);
  clearTimeout(settleTimeout);
  if (!settled) {
    throw new Error(
      `${error.message} Cancellation did not settle underlying benchmark within ${settleTimeoutMs}ms.`,
      { cause: error },
    );
  }
  if (cleanupError) {
    throw new Error(
      `${error.message} Runner cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      { cause: cleanupError },
    );
  }
  throw error;
}
