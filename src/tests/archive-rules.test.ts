import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  ensureArchivePaths,
  MAX_ARCHIVE_PATHS,
  MAX_ARCHIVE_PATHS_IPC_BYTES,
  validateArchivePaths,
  validateExtraArgs,
} from "../archive-rules";

const invokeMock = vi.mocked(invoke);

function uniqueArchivePath(prefix: string): string {
  return `/tmp/${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.7z`;
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("validateExtraArgs", () => {
  it("accepts valid known args", () => {
    expect(() => validateExtraArgs(["-mx=9", "-r", "-bb3"])).not.toThrow();
  });

  it("rejects args not starting with '-'", () => {
    expect(() => validateExtraArgs(["mx=9"])).toThrow(/must start with '-'/);
  });

  it("rejects password args", () => {
    expect(() => validateExtraArgs(["-psecret"])).toThrow();
  });

  it("rejects overwrite-all extract modes", () => {
    expect(() => validateExtraArgs(["-aoa"])).toThrow(/safe extract/);
    expect(() => validateExtraArgs(["-aot"])).toThrow(/safe extract/);
    expect(() => validateExtraArgs(["-aou"])).not.toThrow();
  });

  it("rejects blocked archive type args", () => {
    expect(() => validateExtraArgs(["-tzip"])).toThrow(
      /not allowed in extra args/,
    );
  });

  it("rejects parent traversal inside switch payloads", () => {
    expect(() => validateExtraArgs(["-ir!../../secret"])).toThrow(
      /parent-directory segment/,
    );
    expect(() => validateExtraArgs(["-w../../tmp"])).toThrow(
      /Unknown argument/,
    );
  });

  it("rejects unknown double-dash args", () => {
    expect(() => validateExtraArgs(["--totally-unknown"])).toThrow();
  });

  it("accepts known method switches with digit/= boundaries", () => {
    expect(() =>
      validateExtraArgs(["-mx9", "-mx=9", "-mmt=on", "-md=64m", "-mtc=on"]),
    ).not.toThrow();
  });

  it("rejects method values with path separators or parent segments", () => {
    expect(() => validateExtraArgs(["-m0=../x"])).toThrow(/compression method/);
    expect(() => validateExtraArgs(["-mem=/tmp/x"])).toThrow(
      /compression method/,
    );
    expect(() => validateExtraArgs(["-mtc=a\\b"])).toThrow(
      /compression method/,
    );
    expect(() => validateExtraArgs(["-m0="])).toThrow(/compression method/);
  });

  it("rejects open-ended method prefixes that only share a substring", () => {
    expect(() => validateExtraArgs(["-mxyz"])).toThrow(/compression method/);
    expect(() => validateExtraArgs(["-mfoo"])).toThrow(/compression method/);
  });
});

describe("validateArchivePaths", () => {
  it("preserves paths, validates empties locally, and keeps input order", async () => {
    const path = `  ${uniqueArchivePath("spaced-name")}  `;
    invokeMock.mockResolvedValueOnce([
      {
        path,
        valid: true,
      },
    ]);

    const results = await validateArchivePaths([path, ""]);

    expect(invokeMock).toHaveBeenCalledWith("validate_archive_paths", {
      pathsJson: JSON.stringify([path]),
    });
    expect(results[0]).toEqual({ path, valid: true, reason: undefined });
    expect(results[1]).toEqual({
      path: "",
      valid: false,
      reason: "Path is empty.",
    });
  });

  it("rejects oversized batches without invoking the backend", async () => {
    const paths = Array.from(
      { length: MAX_ARCHIVE_PATHS + 1 },
      (_, index) => `/tmp/archive-${index}.zip`,
    );

    const results = await validateArchivePaths(paths);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(results).toHaveLength(MAX_ARCHIVE_PATHS + 1);
    expect(results[0]).toMatchObject({ valid: false, reason: /At most 4096/ });
  });

  it("rejects oversized serialized IPC requests without invoking the backend", async () => {
    const paths = ["x".repeat(MAX_ARCHIVE_PATHS_IPC_BYTES)];

    const results = await validateArchivePaths(paths);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ valid: false, reason: /safety limit/ });
  });

  it("revalidates repeated probes so replaced files cannot use stale results", async () => {
    const path = uniqueArchivePath("fresh-probe");
    invokeMock.mockResolvedValue([
      {
        path,
        valid: false,
        reason: "signature mismatch",
      },
    ]);

    const first = await validateArchivePaths([path]);
    const second = await validateArchivePaths([path]);

    expect(first[0].valid).toBe(false);
    expect(second[0].valid).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("returns fallback invalid result when backend omits a path", async () => {
    const path = uniqueArchivePath("missing-result");
    invokeMock.mockResolvedValueOnce([]);

    const results = await validateArchivePaths([path]);

    expect(results[0]).toEqual({
      path,
      valid: false,
      reason: "Validation returned no result.",
    });
  });
});

describe("ensureArchivePaths", () => {
  it("returns early when all paths are empty", async () => {
    const probe = vi.fn();

    await ensureArchivePaths(["", ""], "extract", probe);

    expect(probe).not.toHaveBeenCalled();
  });

  it("rejects invalid paths", async () => {
    await expect(
      ensureArchivePaths(["C:/tmp/notes.txt"], "extract", async () => [
        {
          path: "C:/tmp/notes.txt",
          valid: false,
          reason: "File does not exist.",
        },
      ]),
    ).rejects.toThrow(/File does not exist/);
  });

  it("accepts valid paths", async () => {
    await expect(
      ensureArchivePaths(
        ["C:/tmp/archive.7z", "C:/tmp/data.zip"],
        "extract",
        async () => [
          { path: "C:/tmp/archive.7z", valid: true },
          { path: "C:/tmp/data.zip", valid: true },
        ],
      ),
    ).resolves.not.toThrow();
  });

  it("accepts extensionless archives when backend validates them", async () => {
    await expect(
      ensureArchivePaths(
        ["C:/tmp/extensionless-archive"],
        "extract",
        async () => [{ path: "C:/tmp/extensionless-archive", valid: true }],
      ),
    ).resolves.not.toThrow();
  });

  it("wraps backend errors gracefully", async () => {
    await expect(
      ensureArchivePaths(["C:/tmp/archive.7z"], "extract", async () => {
        throw new Error("backend unavailable");
      }),
    ).rejects.toThrow(/Unable to validate selected inputs/);
  });

  it("includes summary suffix when more than three paths are invalid", async () => {
    const invalid = [
      { path: "C:/tmp/a.txt", valid: false, reason: "Not archive" },
      { path: "C:/tmp/b.txt", valid: false, reason: "Not archive" },
      { path: "C:/tmp/c.txt", valid: false, reason: "Not archive" },
      { path: "C:/tmp/d.txt", valid: false, reason: "Not archive" },
    ];

    await expect(
      ensureArchivePaths(
        invalid.map((entry) => entry.path),
        "browse",
        async () => invalid,
      ),
    ).rejects.toThrow(/\(\+1 more\)/);
  });
});
