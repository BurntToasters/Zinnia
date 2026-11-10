import { invoke } from "@tauri-apps/api/core";
import { invokeRun7z } from "./archive/backend-ipc";
import { setRunning } from "./ui";
import { state } from "./state";
import { $ } from "./utils";

let benchmarkCancelRequested = false;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Pull the overall rating from 7z benchmark output. The trailing "Tot:" line
// ends with the combined compress/decompress rating, which 7-Zip reports in MIPS.
export function parseBenchmarkSummary(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("Tot:")) {
      const nums = line.match(/\d+/g);
      if (nums && nums.length > 0) {
        const rating = nums[nums.length - 1];
        return `Rating: ${groupThousands(rating)} MIPS`;
      }
    }
  }
  return null;
}

function setBenchmarkControls(running: boolean): void {
  const button = $("run-benchmark") as HTMLButtonElement;
  const cancel = $("cancel-benchmark") as HTMLButtonElement;
  button.disabled = running;
  cancel.hidden = !running;
  cancel.disabled = !running;
}

export async function runBenchmark(): Promise<void> {
  if (state.running) return;
  const result = $("benchmark-result");
  benchmarkCancelRequested = false;
  setRunning(true);
  setBenchmarkControls(true);
  result.textContent = "Running benchmark…";
  try {
    const res = await invokeRun7z<{ stdout: string; code: number }>({
      args: ["b"],
    });
    if (benchmarkCancelRequested) {
      result.textContent = "Benchmark cancelled.";
      return;
    }
    const summary = parseBenchmarkSummary(res.stdout);
    result.textContent = summary ?? "Benchmark finished (no rating reported).";
  } catch (err) {
    if (benchmarkCancelRequested) {
      result.textContent = "Benchmark cancelled.";
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    result.textContent = `Benchmark failed: ${msg}`;
  } finally {
    benchmarkCancelRequested = false;
    setBenchmarkControls(false);
    setRunning(false);
  }
}

export async function cancelBenchmark(): Promise<void> {
  if (!state.running || benchmarkCancelRequested) return;
  benchmarkCancelRequested = true;
  const cancel = $("cancel-benchmark") as HTMLButtonElement;
  const result = $("benchmark-result");
  cancel.disabled = true;
  result.textContent = "Cancelling benchmark…";
  try {
    await invoke<boolean>("cancel_7z");
  } catch (err) {
    // The run is still going, so let the user try again.
    benchmarkCancelRequested = false;
    cancel.disabled = false;
    const msg = err instanceof Error ? err.message : String(err);
    result.textContent = `Could not cancel the benchmark: ${msg}`;
  }
}
