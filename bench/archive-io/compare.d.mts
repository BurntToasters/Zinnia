export function compareReportsFromFiles(options: {
  candidatePath: string;
  basePath?: string | null;
  requireCandidate?: boolean;
}): Record<string, unknown>;
export const compareReports: typeof compareReportsFromFiles;
export function writeComparisonReports(
  report: Record<string, unknown>,
  outputDir: string,
): { jsonPath: string; markdownPath: string };
export function runComparison(options: {
  candidate: string;
  base?: string | null;
  outputDir: string;
  githubSummary?: string | null;
  requireCandidate?: boolean;
}): {
  report: Record<string, unknown>;
  jsonPath: string;
  markdownPath: string;
};
