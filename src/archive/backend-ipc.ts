import { invoke } from "@tauri-apps/api/core";

export interface Run7zRequest {
  args: string[];
  expectedArchiveIdentity?: string;
  /** Request redacted phase timings from the backend only while debug mode is active. */
  includeIoDiagnostics?: boolean;
}

/** Stable phase names shared by the Rust run_7z diagnostics payload. */
export interface ArchiveIoPhaseTimes {
  validation: number;
  recovery: number;
  inputScan: number;
  snapshot: number;
  memberPreflight: number;
  sevenZipExecution: number;
  quotaMonitoring: number;
  finalization: number;
  total: number;
}

/** Selected backend strategies. Values are enum-like labels, never paths. */
export interface ArchiveIoStrategies {
  inputScan?: string;
  snapshot?: string;
  stage?: string;
  publish?: string;
  quota?: string;
}

export interface ArchiveIoDiagnostics {
  phaseTimes: ArchiveIoPhaseTimes;
  strategies: ArchiveIoStrategies;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  warning_code?: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  archiveIdentityAfter?: string;
  ioDiagnostics?: ArchiveIoDiagnostics;
}

export type BackendJsonInvokeArgs = {
  requestJson: string;
};

const MAX_RUN_7Z_REQUEST_BYTES = 64 * 1024 * 1024;

export function boundedJson(
  value: unknown,
  maxBytes: number,
  label: string,
): string {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > maxBytes) {
    throw new Error(`${label} exceeds its aggregate IPC byte limit.`);
  }
  return json;
}

export function encodeRun7zRequest(request: Run7zRequest): string {
  return boundedJson(request, MAX_RUN_7Z_REQUEST_BYTES, "7-Zip request");
}

export function run7zInvokeArgs(request: Run7zRequest): BackendJsonInvokeArgs {
  return { requestJson: encodeRun7zRequest(request) };
}

export function invokeRun7z<T>(request: Run7zRequest): Promise<T> {
  return invoke<T>("run_7z", run7zInvokeArgs(request));
}
