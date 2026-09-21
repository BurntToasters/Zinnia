export function median(values: number[]): number | null;
export type ArchiveBenchmarkRequest = {
  operation:
    | "browse"
    | "test"
    | "extract"
    | "create"
    | "replace"
    | "update"
    | "selective-extract"
    | "conversion"
    | "batch";
  archive: string;
  source: string;
  output: string;
  target: string;
  selection?: string;
  format: string;
  targetFormat?: string;
  workload: string;
  password?: string;
};
export type ArchiveBenchmarkResult = {
  durationMs: number;
  code: number;
  stdout?: string;
};
export const COMPATIBILITY_CASES: readonly Array<{
  name: string;
  status: string;
  primary?: boolean;
  note: string;
}>;
export function runBenchmark(options: {
  outputDir: string;
  formats: string[];
  workloads: string[];
  operations?: string[];
  operationFormats?: string[];
  operationWorkloads?: string[];
  scale?: string;
  zinniaCommand?: string | null;
  zinniaExecutor?:
    | ((request: ArchiveBenchmarkRequest) => Promise<ArchiveBenchmarkResult>)
    | {
        run(request: ArchiveBenchmarkRequest): Promise<ArchiveBenchmarkResult>;
        close?(): Promise<void> | void;
      };
  zinniaBatchExecutor?:
    | ((request: ArchiveBenchmarkRequest) => Promise<ArchiveBenchmarkResult>)
    | {
        run(request: ArchiveBenchmarkRequest): Promise<ArchiveBenchmarkResult>;
      };
  candidateRevision?: string | null;
  baseRevision?: string | null;
  candidateRef?: string | null;
  baseRef?: string | null;
  baselineReport?: string | null;
  requireZinnia?: boolean;
  keepWorkdir?: boolean;
  compatibility?: boolean;
}): Promise<Record<string, any>>;
export function medianAbsoluteDeviation(values: number[]): number | null;
export function relativeMedianAbsoluteDeviation(
  values: number[],
): number | null;
export function ratioSamples(
  zinniaValues: number[],
  directValues: number[],
): number[];
export function parseArgs(argv: string[]): {
  outputDir: string;
  formats: string[];
  workloads: string[];
  operations: string[];
  operationFormats: string[];
  operationWorkloads: string[];
  scale: string;
  zinniaCommand: string | null;
  candidateRevision: string | null;
  baseRevision: string | null;
  candidateRef: string | null;
  baseRef: string | null;
  baselineReport: string | null;
  requireZinnia: boolean;
  keepWorkdir: boolean;
  compatibility: boolean;
  help: boolean;
};
export function ratio(
  zinniaMedianMs: number | null | undefined,
  directMedianMs: number | null | undefined,
): number | null;
export function parseCommandTemplate(commandJson: string): string[];
export function parseOperationCommandTemplates(
  commandJson: string,
): Record<string, string[]>;
export function redactText(value: unknown, paths?: string[]): string;
export function verifyBrowseListing(
  stdout: string,
  expectedManifest: Array<{ path: string; bytes: number; sha256: string }>,
): { ok: boolean; reason: string | null };
export function hasArchiveLinkMetadata(stdout: string): boolean;
export function createArchiveBenchmarkRequest(request: {
  operation: string;
  archive: string;
  source: string;
  output: string;
  target: string;
  selection?: string;
  format: string;
  targetFormat?: string;
  workload: string;
  password?: string;
}): Record<string, string>;
export function runAlternatingExecutorPair(options: {
  direct: (context: { phase: string; iteration: number }) => unknown;
  zinnia?: ((context: { phase: string; iteration: number }) => unknown) | null;
  measuredIterations?: number;
  warmupIterations?: number;
  redactionPaths?: string[];
}): Promise<{
  direct: Record<string, unknown>;
  zinnia: Record<string, unknown> | null;
  ratioSamples: number[];
}>;
export function classifyTargetStatus(
  candidateRatio: number | null,
  workload: string,
  applicable?: boolean,
): "met" | "missed" | "not-applicable";
export function classifyTrendStatus(options: {
  candidateRatio: number | null;
  baselineRatio: number | null;
  candidateRelativeMad?: number | null;
  baselineRelativeMad?: number | null;
  baselineAvailable?: boolean;
}): "improved" | "stable" | "regressed" | "noisy" | "baseline-unavailable";
export function compareMeasurementItem(
  candidate: Record<string, unknown>,
  baseline?: Record<string, unknown> | null,
): Record<string, unknown>;
export function compareBenchmarkReports(
  candidate: Record<string, unknown>,
  baseline?: Record<string, unknown> | null,
  options?: { requireCandidate?: boolean },
): Record<string, any>;
export const compareReports: typeof compareBenchmarkReports;
export function itemRatioStats(
  item: Record<string, unknown>,
): Record<string, unknown>;
export function renderMarkdown(report: Record<string, unknown>): string;
export function renderGithubSummary(report: Record<string, unknown>): string;
