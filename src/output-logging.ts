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
  const preview = lines.slice(0, PREVIEW_LINE_COUNT).map(line => line.trim()).filter(Boolean);
  const previewText = preview.length > 0 ? ` Preview: ${preview.join(" | ")}` : "";
  return `${label}: ${lines.length} line(s), ${normalized.length} chars.${previewText}`;
}

export function formatCommandOutputForLogs(
  stdout: string,
  stderr: string,
  verbosity: OutputLogVerbosity
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
    entries.push({ level: "info", text: summarizeStream("stdout", stdoutTrimmed) });
  }
  if (stderrTrimmed) {
    entries.push({ level: "error", text: summarizeStream("stderr", stderrTrimmed) });
  }
  return entries;
}
