import { invoke } from "@tauri-apps/api/core";
import { MAX_LOG_LINES, redactSensitiveText } from "../utils";
import { state, dom } from "../state";
import { type LogVerbosity } from "../settings-model";

type LogLevel = "info" | "debug" | "error";

let logWriteQueue = Promise.resolve();
const MAX_LOG_ENTRY_CHARS = 8_000;
const LOG_CHUNK_CHARS = 2_000;
const MAX_PENDING_LOCAL_LOG_WRITES = 250;
let pendingLocalLogWrites = 0;
let droppedLocalLogWrites = 0;

export function buildLogFragments(input: string): string[] {
  if (input.length <= MAX_LOG_ENTRY_CHARS) return [input];

  const capped = input.slice(0, MAX_LOG_ENTRY_CHARS);
  const chunks: string[] = [];
  for (let i = 0; i < capped.length; i += LOG_CHUNK_CHARS) {
    chunks.push(capped.slice(i, i + LOG_CHUNK_CHARS));
  }
  chunks.push(`[truncated ${input.length - MAX_LOG_ENTRY_CHARS} chars]`);
  return chunks;
}

export function shouldPersistLevel(
  level: LogLevel,
  verbosity: LogVerbosity,
): boolean {
  if (level === "debug") return verbosity === "debug";
  return true;
}

function enqueueLocalLogLine(line: string): void {
  pendingLocalLogWrites += 1;
  logWriteQueue = logWriteQueue
    .then(() => invoke("append_local_log", { line }).then(() => undefined))
    .catch(() => {
      // Ignore logging backend failures to avoid noisy loops.
    })
    .finally(() => {
      pendingLocalLogWrites = Math.max(0, pendingLocalLogWrites - 1);
    });
}

function persistLocalLog(level: LogLevel, line: string): void {
  if (!state.currentSettings.localLoggingEnabled) return;
  if (!shouldPersistLevel(level, state.currentSettings.logVerbosity)) return;

  if (pendingLocalLogWrites >= MAX_PENDING_LOCAL_LOG_WRITES) {
    droppedLocalLogWrites += 1;
    return;
  }

  if (droppedLocalLogWrites > 0) {
    const dropped = droppedLocalLogWrites;
    droppedLocalLogWrites = 0;
    enqueueLocalLogLine(
      `${new Date().toISOString()} [error] Local log queue overloaded; dropped ${dropped} log entr${dropped === 1 ? "y" : "ies"}.`,
    );
  }

  const entry = `${new Date().toISOString()} [${level}] ${line}`;
  enqueueLocalLogLine(entry);
}

function trimLog() {
  const text = dom.logEl.textContent || "";
  const lines = text.split("\n");
  if (lines.length > MAX_LOG_LINES) {
    dom.logEl.textContent = lines
      .slice(lines.length - MAX_LOG_LINES)
      .join("\n");
  }
}

export function log(line: string, level: LogLevel = "info") {
  const sanitized = redactSensitiveText(line);
  const fragments = buildLogFragments(sanitized);

  for (const [index, fragment] of fragments.entries()) {
    const stamp = new Date().toLocaleTimeString();
    const marker =
      fragments.length > 1 ? ` (${index + 1}/${fragments.length})` : "";
    const rendered = `${fragment}${marker}`;
    dom.logEl.textContent += `[${stamp}] ${rendered}\n`;
    persistLocalLog(level, rendered);
  }

  trimLog();
  dom.logEl.scrollTop = dom.logEl.scrollHeight;
}

export function devLog(line: string) {
  if (import.meta.env.DEV || state.currentSettings.logVerbosity === "debug") {
    log(line, "debug");
  }
}
