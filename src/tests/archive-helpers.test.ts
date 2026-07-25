import { describe, it, expect, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import {
  isEncryptedFlag,
  methodLooksEncrypted,
  looksLikePasswordRequiredError,
  describe7zError,
  truncateForDialog,
  withPassword,
  formatBatchEta,
} from "../archive";
import { withLiveProgress } from "../archive/runtime";

describe("isEncryptedFlag", () => {
  it('returns true for "+"', () => {
    expect(isEncryptedFlag("+")).toBe(true);
  });

  it('returns true for "yes" (case-insensitive)', () => {
    expect(isEncryptedFlag("yes")).toBe(true);
    expect(isEncryptedFlag("YES")).toBe(true);
    expect(isEncryptedFlag("Yes")).toBe(true);
  });

  it('returns true for "true" (case-insensitive)', () => {
    expect(isEncryptedFlag("true")).toBe(true);
    expect(isEncryptedFlag("TRUE")).toBe(true);
  });

  it('returns true for "1"', () => {
    expect(isEncryptedFlag("1")).toBe(true);
  });

  it("trims whitespace", () => {
    expect(isEncryptedFlag("  +  ")).toBe(true);
    expect(isEncryptedFlag("\tyes\n")).toBe(true);
  });

  it("returns false for negative/empty values", () => {
    expect(isEncryptedFlag("-")).toBe(false);
    expect(isEncryptedFlag("no")).toBe(false);
    expect(isEncryptedFlag("false")).toBe(false);
    expect(isEncryptedFlag("0")).toBe(false);
    expect(isEncryptedFlag("")).toBe(false);
    expect(isEncryptedFlag("  ")).toBe(false);
  });
});

describe("methodLooksEncrypted", () => {
  it("detects 7zAES", () => {
    expect(methodLooksEncrypted("7zAES:19")).toBe(true);
    expect(methodLooksEncrypted("7zaes")).toBe(true);
  });

  it("detects AES", () => {
    expect(methodLooksEncrypted("AES-256 Deflate")).toBe(true);
    expect(methodLooksEncrypted("aes")).toBe(true);
  });

  it("detects ZipCrypto", () => {
    expect(methodLooksEncrypted("ZipCrypto Deflate")).toBe(true);
    expect(methodLooksEncrypted("zipcrypto")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(methodLooksEncrypted("AES-256")).toBe(true);
    expect(methodLooksEncrypted("aes-256")).toBe(true);
    expect(methodLooksEncrypted("ZIPCRYPTO")).toBe(true);
  });

  it("returns false for non-encrypted methods", () => {
    expect(methodLooksEncrypted("LZMA2:24")).toBe(false);
    expect(methodLooksEncrypted("Deflate")).toBe(false);
    expect(methodLooksEncrypted("PPMd")).toBe(false);
    expect(methodLooksEncrypted("BZip2")).toBe(false);
  });

  it("returns false for empty/whitespace", () => {
    expect(methodLooksEncrypted("")).toBe(false);
    expect(methodLooksEncrypted("  ")).toBe(false);
  });
});

describe("looksLikePasswordRequiredError", () => {
  it("detects 'wrong password' errors", () => {
    expect(looksLikePasswordRequiredError("Wrong password", "")).toBe(true);
    expect(looksLikePasswordRequiredError("", "wrong password?")).toBe(true);
  });

  it("detects 'can not open encrypted archive'", () => {
    expect(
      looksLikePasswordRequiredError("Can not open encrypted archive", ""),
    ).toBe(true);
  });

  it("detects 'can't open encrypted archive'", () => {
    expect(
      looksLikePasswordRequiredError("Can't open encrypted archive", ""),
    ).toBe(true);
  });

  it("does not mistake corrupted encrypted data for a password prompt", () => {
    expect(
      looksLikePasswordRequiredError("", "Data Error in encrypted file: x.dat"),
    ).toBe(false);
  });

  it("detects 'encrypted headers'", () => {
    expect(looksLikePasswordRequiredError("Encrypted Headers found", "")).toBe(
      true,
    );
  });

  it("detects 'enter password'", () => {
    expect(looksLikePasswordRequiredError("Enter password:", "")).toBe(true);
  });

  it("requires an actionable password diagnostic", () => {
    expect(looksLikePasswordRequiredError("Archive is encrypted", "")).toBe(
      false,
    );
  });

  it("is case-insensitive", () => {
    expect(looksLikePasswordRequiredError("WRONG PASSWORD", "")).toBe(true);
  });

  it("checks both stdout and stderr", () => {
    expect(looksLikePasswordRequiredError("", "wrong password")).toBe(true);
    expect(looksLikePasswordRequiredError("wrong password", "")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(
      looksLikePasswordRequiredError("Everything is Ok", "No errors"),
    ).toBe(false);
    expect(looksLikePasswordRequiredError("", "")).toBe(false);
  });
});

describe("truncateForDialog", () => {
  it("returns text unchanged when under maxChars", () => {
    expect(truncateForDialog("short text")).toBe("short text");
  });

  it("returns text unchanged when exactly at maxChars", () => {
    const text = "a".repeat(4000);
    expect(truncateForDialog(text)).toBe(text);
  });

  it("truncates text exceeding maxChars and appends notice", () => {
    const text = "a".repeat(5000);
    const result = truncateForDialog(text);
    expect(result).toContain("a".repeat(4000));
    expect(result).toContain("[truncated 1000 chars]");
  });

  it("respects custom maxChars", () => {
    const text = "a".repeat(200);
    const result = truncateForDialog(text, 100);
    expect(result).toContain("[truncated 100 chars]");
    expect(result.startsWith("a".repeat(100))).toBe(true);
  });

  it("handles empty string", () => {
    expect(truncateForDialog("")).toBe("");
  });
});

describe("describe7zError", () => {
  it("hints for wrong password", () => {
    expect(describe7zError("", "Wrong password")).toMatch(/password/i);
  });

  it("hints for disk full", () => {
    expect(describe7zError("", "No space left on device")).toMatch(
      /disk space/i,
    );
  });

  it("hints for damaged archive", () => {
    expect(describe7zError("", "CRC Failed")).toMatch(/damaged|CRC/i);
  });

  it("hints for permission denied", () => {
    expect(describe7zError("", "Access is denied.")).toMatch(/permission/i);
  });

  it("hints for unsupported method", () => {
    expect(describe7zError("", "Unsupported Method")).toMatch(/method/i);
  });

  it("hints for unsupported archive open failures", () => {
    expect(describe7zError("", "Can not open the file as archive")).toMatch(
      /not a supported archive|corrupted/i,
    );
    expect(describe7zError("", "Can not open file as archive")).toMatch(
      /not a supported archive|corrupted/i,
    );
  });

  it("hints when a path disappeared mid-operation", () => {
    expect(
      describe7zError("", "The system cannot find the path specified"),
    ).toMatch(/no longer exists/i);
    expect(describe7zError("", "file not found")).toMatch(/no longer exists/i);
  });

  it("hints for create/permission failures", () => {
    expect(describe7zError("", "Can not create output file")).toMatch(
      /permission/i,
    );
  });

  it("returns empty string for unrecognized output", () => {
    expect(describe7zError("Everything is Ok", "")).toBe("");
  });
});

describe("withPassword", () => {
  it("inserts -p before the -- separator", () => {
    const args = ["x", "-o/tmp/out", "-y", "--", "archive.7z"];
    expect(withPassword(args, "secret")).toEqual([
      "x",
      "-o/tmp/out",
      "-y",
      "-psecret",
      "--",
      "archive.7z",
    ]);
  });

  it("replaces an existing -p switch", () => {
    const args = ["x", "-pold", "--", "archive.7z"];
    expect(withPassword(args, "new")).toEqual([
      "x",
      "-pnew",
      "--",
      "archive.7z",
    ]);
  });

  it("appends -p when there is no separator", () => {
    expect(withPassword(["l", "archive.7z"], "pw")).toEqual([
      "l",
      "archive.7z",
      "-ppw",
    ]);
  });
});

describe("formatBatchEta", () => {
  it("returns empty before progress or at completion", () => {
    expect(formatBatchEta(0, 0)).toBe("");
    expect(formatBatchEta(1000, 100)).toBe("");
  });

  it("estimates seconds and minutes", () => {
    expect(formatBatchEta(10_000, 50)).toBe("~10s left");
    expect(formatBatchEta(18_000, 10)).toBe("~2m 42s left");
  });
});

describe("withLiveProgress", () => {
  it("renders file progress and removes its listener after completion", async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    vi.mocked(listen).mockImplementation(async (_eventName, callback) => {
      handler = callback as (event: { payload: unknown }) => void;
      return unlisten;
    });

    let complete: ((value: string) => void) | undefined;
    const action = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const result = withLiveProgress(() => action);
    await Promise.resolve();

    handler?.({
      payload: { percent: 50, currentFile: "/tmp/nested/archive.7z" },
    });
    expect(document.getElementById("progress")?.textContent).toContain(
      "archive.7z",
    );

    complete?.("done");
    await expect(result).resolves.toBe("done");
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
