import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  compressInputProbeInvokeArgs,
  encodeCompressInputProbe,
  encodeRun7zRequest,
  invokeCompressInputProbe,
  invokeRun7z,
  run7zInvokeArgs,
} from "../archive/backend-ipc";

const invokeMock = vi.mocked(invoke);

describe("bounded archive IPC envelopes", () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue(undefined);
  });

  it("encodes run_7z arguments and identity as one aggregate JSON string", () => {
    const encoded = encodeRun7zRequest({
      args: ["x", "-psecret", "--", "/tmp/archive.7z"],
      expectedArchiveIdentity: "a".repeat(64),
    });
    expect(JSON.parse(encoded)).toEqual({
      args: ["x", "-psecret", "--", "/tmp/archive.7z"],
      expectedArchiveIdentity: "a".repeat(64),
    });
  });

  it("builds and invokes the exact camelCase run_7z Tauri argument object", async () => {
    const request = {
      args: ["x", "-spd", "--", "/tmp/archive.7z"],
      expectedArchiveIdentity: "b".repeat(64),
    };
    const expected = {
      requestJson: JSON.stringify(request),
    };

    expect(run7zInvokeArgs(request)).toEqual(expected);
    await invokeRun7z(request);
    expect(invokeMock).toHaveBeenCalledWith("run_7z", expected);
    expect(Object.keys(invokeMock.mock.calls[0]?.[1] ?? {})).toEqual([
      "requestJson",
    ]);
  });

  it("encodes compress probe roots as one aggregate JSON string", () => {
    expect(JSON.parse(encodeCompressInputProbe(["/tmp/a", "/tmp/b"]))).toEqual([
      "/tmp/a",
      "/tmp/b",
    ]);
  });

  it("builds and invokes the exact camelCase probe Tauri argument object", async () => {
    const paths = ["/tmp/a", "/tmp/b"];
    const expected = { requestJson: JSON.stringify(paths) };

    expect(compressInputProbeInvokeArgs(paths)).toEqual(expected);
    await invokeCompressInputProbe(paths);
    expect(invokeMock).toHaveBeenCalledWith("probe_compress_inputs", expected);
    expect(Object.keys(invokeMock.mock.calls[0]?.[1] ?? {})).toEqual([
      "requestJson",
    ]);
  });
});
