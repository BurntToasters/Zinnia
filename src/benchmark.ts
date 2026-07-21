import { invoke } from "@tauri-apps/api/core";
import { $ } from "./utils";

// Pull the overall rating from 7z benchmark output (the trailing "Tot:" line,
// whose last column is the combined compress/decompress rating in KiB/s-ish units).
export function parseBenchmarkSummary(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("Tot:")) {
      const nums = line.match(/\d+/g);
      if (nums && nums.length > 0) {
        return `Rating: ${nums[nums.length - 1]}`;
      }
    }
  }
  return null;
}

export async function runBenchmark() {
  const button = $("run-benchmark") as HTMLButtonElement;
  const result = $("benchmark-result");
  button.disabled = true;
  result.textContent = "Running benchmark…";
  try {
    const res = await invoke<{ stdout: string; code: number }>("run_7z", {
      args: ["b"],
    });
    const summary = parseBenchmarkSummary(res.stdout);
    result.textContent = summary ?? "Benchmark finished (no rating reported).";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.textContent = `Benchmark failed: ${msg}`;
  } finally {
    button.disabled = false;
  }
}
