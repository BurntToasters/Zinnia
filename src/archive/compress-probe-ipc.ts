import { invoke } from "@tauri-apps/api/core";
import { boundedJson, type BackendJsonInvokeArgs } from "./backend-ipc";

const MAX_COMPRESS_PROBE_REQUEST_BYTES = 4 * 1024 * 1024;

export function encodeCompressInputProbe(paths: string[]): string {
  return boundedJson(
    paths,
    MAX_COMPRESS_PROBE_REQUEST_BYTES,
    "Compress-input probe",
  );
}

export function compressInputProbeInvokeArgs(
  paths: string[],
): BackendJsonInvokeArgs {
  return { requestJson: encodeCompressInputProbe(paths) };
}

export function invokeCompressInputProbe<T>(paths: string[]): Promise<T> {
  return invoke<T>(
    "probe_compress_inputs",
    compressInputProbeInvokeArgs(paths),
  );
}
