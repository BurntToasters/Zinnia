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
    expect(() =>
      validateExtraArgs(["-mx=9", "-r", "-bb3"], "compress"),
    ).not.toThrow();
  });

  it("rejects args not starting with '-'", () => {
    expect(() => validateExtraArgs(["mx=9"], "compress")).toThrow(
      /must start with '-'/,
    );
  });

  it("rejects password args", () => {
    expect(() => validateExtraArgs(["-psecret"], "compress")).toThrow();
  });

  it("rejects every overwrite-policy arg because Zinnia sets the safe mode itself", () => {
    for (const arg of ["-aoa", "-aot", "-aou", "-aos", "-ao"]) {
      expect(() => validateExtraArgs([arg], "extract")).toThrow(
        /overwrite policy|safe extract/,
      );
    }
  });

  it("allows only the stdout progress switch -bsp1", () => {
    expect(() => validateExtraArgs(["-bsp1"], "extract")).not.toThrow();
    expect(() => validateExtraArgs(["-bsp2"], "extract")).toThrow(/-bsp1/);
    expect(() => validateExtraArgs(["-bse0"], "extract")).toThrow(/-bsp1/);
    expect(() => validateExtraArgs(["-bso0"], "extract")).toThrow(/-bsp1/);
  });

  it("restricts -y to extract like validation.rs does", () => {
    expect(() => validateExtraArgs(["-y"], "extract")).not.toThrow();
    expect(() => validateExtraArgs(["-y"], "compress")).toThrow(
      /not allowed for compress/,
    );
  });

  it("restricts listing/time switches to compress like validation.rs does", () => {
    for (const arg of ["-stl", "-slp", "-ssp", "-sse"]) {
      expect(() => validateExtraArgs([arg], "compress")).not.toThrow();
      expect(() => validateExtraArgs([arg], "extract")).toThrow(
        /not allowed for extract/,
      );
    }
  });

  it("accepts shared diagnostics for both commands", () => {
    expect(() =>
      validateExtraArgs(
        ["-bt", "-bb2", "-slt", "-scsUTF-8", "-sccUTF-8"],
        "extract",
      ),
    ).not.toThrow();
    expect(() =>
      validateExtraArgs(
        ["-bt", "-bb2", "-slt", "-scsUTF-8", "-sccUTF-8"],
        "compress",
      ),
    ).not.toThrow();
  });

  it("rejects malformed shared switches the backend rejects", () => {
    for (const arg of [
      "-bb",
      "-bb4",
      "-bb10",
      "-scs",
      "-scc",
      "-btc",
      "-sltx",
    ]) {
      expect(() => validateExtraArgs([arg], "extract")).toThrow();
    }
  });

  it("rejects ZipCrypto method switches", () => {
    expect(() => validateExtraArgs(["-mem=ZipCrypto"], "compress")).toThrow(
      /AES-256/,
    );
    expect(() => validateExtraArgs(["-mem=AES256"], "compress")).not.toThrow();
  });

  it("rejects blocked archive type args", () => {
    expect(() => validateExtraArgs(["-tzip"], "compress")).toThrow(
      /not allowed in extra args/,
    );
  });

  it("rejects every include/exclude list form, expansion or listfile", () => {
    for (const arg of [
      "-ir!../../secret",
      "-x!secret.txt",
      "-i@files.txt",
      "-x@list",
      "-i",
      "-x",
    ]) {
      expect(() => validateExtraArgs([arg], "extract")).toThrow(
        /include or exclude lists/,
      );
    }
  });

  it("rejects working-dir args", () => {
    expect(() => validateExtraArgs(["-w../../tmp"], "extract")).toThrow(
      /Unknown argument/,
    );
  });

  it("rejects unknown double-dash args", () => {
    expect(() =>
      validateExtraArgs(["--totally-unknown"], "compress"),
    ).toThrow();
  });

  it("accepts known method switches with digit/= boundaries", () => {
    expect(() =>
      validateExtraArgs(
        ["-mx9", "-mx=9", "-mmt=on", "-md=64m", "-mtc=on"],
        "compress",
      ),
    ).not.toThrow();
  });

  it("rejects compression method switches during extraction", () => {
    expect(() => validateExtraArgs(["-mx=9"], "extract")).toThrow(
      /not allowed for extract/,
    );
  });

  it("rejects method values with path separators or parent segments", () => {
    expect(() => validateExtraArgs(["-m0=../x"], "compress")).toThrow(
      /compression method/,
    );
    expect(() => validateExtraArgs(["-mem=/tmp/x"], "compress")).toThrow(
      /compression method/,
    );
    expect(() => validateExtraArgs(["-mtc=a\\b"], "compress")).toThrow(
      /compression method/,
    );
    expect(() => validateExtraArgs(["-m0="], "compress")).toThrow(
      /compression method/,
    );
    expect(() => validateExtraArgs(["-mx=../evil"], "compress")).toThrow(
      /compression method/,
    );
  });

  it("rejects open-ended method prefixes that only share a substring", () => {
    expect(() => validateExtraArgs(["-mxyz"], "compress")).toThrow(
      /compression method/,
    );
    expect(() => validateExtraArgs(["-mfoo"], "compress")).toThrow(
      /compression method/,
    );
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
