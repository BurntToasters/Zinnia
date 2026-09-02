import { invoke } from "@tauri-apps/api/core";

export interface Run7zRequest {
  args: string[];
  expectedArchiveIdentity?: string;
}

export type BackendJsonInvokeArgs = {
  requestJson: string;
};

const MAX_RUN_7Z_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_COMPRESS_PROBE_REQUEST_BYTES = 4 * 1024 * 1024;

function boundedJson(value: unknown, maxBytes: number, label: string): string {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > maxBytes) {
    throw new Error(`${label} exceeds its aggregate IPC byte limit.`);
  }
  return json;
}

export function encodeRun7zRequest(request: Run7zRequest): string {
  return boundedJson(request, MAX_RUN_7Z_REQUEST_BYTES, "7-Zip request");
}

export function encodeCompressInputProbe(paths: string[]): string {
  return boundedJson(
    paths,
    MAX_COMPRESS_PROBE_REQUEST_BYTES,
    "Compress-input probe",
  );
}

export function run7zInvokeArgs(request: Run7zRequest): BackendJsonInvokeArgs {
  return { requestJson: encodeRun7zRequest(request) };
}

export function compressInputProbeInvokeArgs(
  paths: string[],
): BackendJsonInvokeArgs {
  return { requestJson: encodeCompressInputProbe(paths) };
}

export function invokeRun7z<T>(request: Run7zRequest): Promise<T> {
  return invoke<T>("run_7z", run7zInvokeArgs(request));
}

export function invokeCompressInputProbe<T>(paths: string[]): Promise<T> {
  return invoke<T>(
    "probe_compress_inputs",
    compressInputProbeInvokeArgs(paths),
  );
}
