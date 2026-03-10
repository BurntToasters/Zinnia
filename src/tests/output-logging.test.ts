import assert from "node:assert/strict";

import { formatCommandOutputForLogs } from "../output-logging.ts";

export function runOutputLoggingTests() {
  const infoEntries = formatCommandOutputForLogs(
    "line 1\nline 2\nline 3\nline 4",
    "warn 1\nwarn 2",
    "info"
  );
  assert.equal(infoEntries.length, 2);
  assert.equal(infoEntries[0].text.includes("stdout:"), true);
  assert.equal(infoEntries[0].text.includes("line(s)"), true);
  assert.equal(infoEntries[0].text.includes("Preview:"), true);
  assert.equal(infoEntries[1].level, "error");

  const big = "x".repeat(25_000);
  const debugEntries = formatCommandOutputForLogs(big, "", "debug");
  assert.equal(debugEntries.length, 1);
  assert.equal(debugEntries[0].text.startsWith("stdout:\n"), true);
  assert.equal(debugEntries[0].text.includes("[truncated "), true);
}
