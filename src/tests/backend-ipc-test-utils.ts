export interface DecodedRun7zRequest {
  args: string[];
  expectedArchiveIdentity?: string;
}

export function decodeRun7zInvokePayload(
  payload: unknown,
): DecodedRun7zRequest {
  const requestJson = (payload as { requestJson?: unknown } | undefined)
    ?.requestJson;
  if (typeof requestJson !== "string") {
    throw new Error("run_7z test payload is missing requestJson");
  }
  const request: unknown = JSON.parse(requestJson);
  if (typeof request !== "object" || request === null) {
    throw new Error("run_7z test payload has an invalid JSON request");
  }
  const record = request as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    !Array.isArray(record.args) ||
    !record.args.every((argument) => typeof argument === "string") ||
    (record.expectedArchiveIdentity !== undefined &&
      typeof record.expectedArchiveIdentity !== "string") ||
    keys.some((key) => key !== "args" && key !== "expectedArchiveIdentity")
  ) {
    throw new Error("run_7z test payload has an invalid JSON request");
  }
  return {
    args: record.args as string[],
    ...(typeof record.expectedArchiveIdentity === "string"
      ? { expectedArchiveIdentity: record.expectedArchiveIdentity }
      : {}),
  };
}

export function decodeCompressProbeInvokePayload(payload: unknown): string[] {
  const requestJson = (payload as { requestJson?: unknown } | undefined)
    ?.requestJson;
  if (typeof requestJson !== "string") {
    throw new Error(
      "probe_compress_inputs test payload is missing requestJson",
    );
  }
  const paths: unknown = JSON.parse(requestJson);
  if (
    !Array.isArray(paths) ||
    !paths.every((inputPath) => typeof inputPath === "string")
  ) {
    throw new Error(
      "probe_compress_inputs test payload has invalid JSON paths",
    );
  }
  return paths;
}
