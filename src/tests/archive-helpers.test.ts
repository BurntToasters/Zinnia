import { describe, it, expect } from "vitest";
import {
  isEncryptedFlag,
  methodLooksEncrypted,
  looksLikePasswordRequiredError,
  truncateForDialog,
} from "../archive";

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

  it("detects 'data error in encrypted file'", () => {
    expect(
      looksLikePasswordRequiredError("", "Data Error in encrypted file: x.dat"),
    ).toBe(true);
  });

  it("detects 'encrypted headers'", () => {
    expect(looksLikePasswordRequiredError("Encrypted Headers found", "")).toBe(
      true,
    );
  });

  it("detects 'enter password'", () => {
    expect(looksLikePasswordRequiredError("Enter password:", "")).toBe(true);
  });

  it("detects 'is encrypted'", () => {
    expect(looksLikePasswordRequiredError("Archive is encrypted", "")).toBe(
      true,
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
