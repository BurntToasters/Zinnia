import type { ArchiveIoDiagnostics } from "./archive/backend-ipc";

export type OutputLogVerbosity = "info" | "debug";
export type OutputLogEntry = { level: "info" | "error"; text: string };

const PREVIEW_LINE_COUNT = 3;
const MAX_DEBUG_STREAM_CHARS = 20_000;

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[truncated ${omitted} chars]`;
}

function summarizeStream(label: string, text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  const preview = lines
    .slice(0, PREVIEW_LINE_COUNT)
    .map((line) => line.trim())
    .filter(Boolean);
  const previewText =
    preview.length > 0 ? ` Preview: ${preview.join(" | ")}` : "";
  return `${label}: ${lines.length} line(s), ${normalized.length} chars.${previewText}`;
}

export function formatCommandOutputForLogs(
  stdout: string,
  stderr: string,
  verbosity: OutputLogVerbosity,
): OutputLogEntry[] {
  const entries: OutputLogEntry[] = [];
  const stdoutTrimmed = stdout.trim();
  const stderrTrimmed = stderr.trim();

  if (verbosity === "debug") {
    if (stdoutTrimmed) {
      entries.push({
        level: "info",
        text: `stdout:\n${truncateText(stdoutTrimmed, MAX_DEBUG_STREAM_CHARS)}`,
      });
    }
    if (stderrTrimmed) {
      entries.push({
        level: "error",
        text: `stderr:\n${truncateText(stderrTrimmed, MAX_DEBUG_STREAM_CHARS)}`,
      });
    }
    return entries;
  }

  if (stdoutTrimmed) {
    entries.push({
      level: "info",
      text: summarizeStream("stdout", stdoutTrimmed),
    });
  }
  if (stderrTrimmed) {
    entries.push({
      level: "error",
      text: summarizeStream("stderr", stderrTrimmed),
    });
  }
  return entries;
}

const IO_PHASES = [
  ["validation", "validation"],
  ["recovery", "recovery"],
  ["inputScan", "input scan"],
  ["snapshot", "snapshot"],
  ["memberPreflight", "member preflight"],
  ["sevenZipExecution", "7-Zip"],
  ["quotaMonitoring", "quota"],
  ["finalization", "finalization"],
  ["total", "total"],
] as const;

/**
 * Format backend I/O timings for Debug Console. Keep this allow-listed and
 * path-free: diagnostics are operational metadata, not command output.
 */
export function formatArchiveIoDiagnosticsForDebug(
  diagnostics: ArchiveIoDiagnostics,
): string {
  const phaseTimes = diagnostics?.phaseTimes;
  const phaseSummary = phaseTimes
    ? IO_PHASES.map(([key, label]) => {
        const value = phaseTimes[key];
        return typeof value === "number" && Number.isFinite(value)
          ? `${label}=${Math.max(0, value).toFixed(1)}ms`
          : null;
      })
        .filter((part): part is string => part !== null)
        .join(", ")
    : "";

  const strategySummary = Object.entries(diagnostics?.strategies ?? {})
    .filter(
      ([key, value]) =>
        ["inputScan", "snapshot", "stage", "publish", "quota"].includes(key) &&
        typeof value === "string",
    )
    .map(([key, value]) => {
      // Strategy labels come from backend enums. Redact unexpected path-like
      // data instead of copying it into the user-visible debug console.
      const safe = /^[A-Za-z0-9_. -]{1,80}$/.test(value) ? value : "(redacted)";
      return `${key}=${safe}`;
    })
    .join(", ");

  const parts = [
    phaseSummary ? `phases: ${phaseSummary}` : "",
    strategySummary ? `strategies: ${strategySummary}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `I/O diagnostics: ${parts.join("; ")}` : "";
}
