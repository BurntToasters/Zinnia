import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareBenchmarkReports, renderMarkdown } from "./benchmark.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function usage() {
  return [
    "Usage: node bench/archive-io/compare.mjs --candidate <report.json> [options]",
    "",
    "Options:",
    "  --candidate <path>          Candidate JSON report.",
    "  --base <path>               Base JSON report (optional).",
    "  --baseline <path>           Alias for --base.",
    "  --output-dir <path>         Write comparison JSON and Markdown here.",
    "  --github-summary <path>     Append Markdown to GitHub step summary.",
    "  --allow-missing-candidate   Do not fail missing candidate measurements.",
    "  --help                      Show this help.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    candidate: null,
    base: null,
    outputDir: process.env.ZINNIA_BENCH_REPORT_DIR || process.cwd(),
    githubSummary: process.env.GITHUB_STEP_SUMMARY || null,
    requireCandidate: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value.`);
      return argv[index];
    };
    if (arg === "--candidate") options.candidate = next();
    else if (arg === "--base" || arg === "--baseline") options.base = next();
    else if (arg === "--output-dir") options.outputDir = next();
    else if (arg === "--github-summary") options.githubSummary = next();
    else if (arg === "--allow-missing-candidate")
      options.requireCandidate = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && !options.candidate) {
    throw new Error("--candidate is required.");
  }
  return options;
}

function loadReport(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(
      `${label} report cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function compareReportsFromFiles({
  candidatePath,
  basePath = null,
  requireCandidate = true,
}) {
  const candidate = loadReport(candidatePath, "Candidate");
  const base = basePath ? loadReport(basePath, "Base") : null;
  return compareBenchmarkReports(candidate, base, { requireCandidate });
}

export const compareReports = compareReportsFromFiles;

export function writeComparisonReports(report, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const jsonPath = resolve(outputDir, "archive-io-comparison.json");
  const markdownPath = resolve(outputDir, "archive-io-comparison.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdown(report));
  return { jsonPath, markdownPath };
}

export function runComparison(options) {
  const report = compareReportsFromFiles({
    candidatePath: options.candidate,
    basePath: options.base,
    requireCandidate: options.requireCandidate,
  });
  const paths = writeComparisonReports(report, options.outputDir);
  if (options.githubSummary) {
    appendFileSync(options.githubSummary, renderMarkdown(report));
  }
  return { report, ...paths };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(SCRIPT_DIR, "compare.mjs")
) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    const result = runComparison(options);
    console.log(`Archive I/O comparison JSON report: ${result.jsonPath}`);
    console.log(
      `Archive I/O comparison Markdown report: ${result.markdownPath}`,
    );
    if (result.report.failures.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
