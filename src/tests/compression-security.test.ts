import { describe, it, expect } from "vitest";
import {
  getCompressionSecuritySupport,
  normalizeCompressionSecurityOptions,
  validateCompressionSecurityOptions,
} from "../compression-security";

describe("getCompressionSecuritySupport", () => {
  it("returns full support for 7z", () => {
    expect(getCompressionSecuritySupport("7z")).toEqual({
      password: true,
      encryptHeaders: true,
    });
  });

  it("returns password-only support for zip", () => {
    expect(getCompressionSecuritySupport("zip")).toEqual({
      password: true,
      encryptHeaders: false,
    });
  });

  it("returns no support for tar", () => {
    expect(getCompressionSecuritySupport("tar")).toEqual({
      password: false,
      encryptHeaders: false,
    });
  });

  it("returns no support for unknown formats", () => {
    expect(getCompressionSecuritySupport("unknown-format")).toEqual({
      password: false,
      encryptHeaders: false,
    });
  });
});

describe("normalizeCompressionSecurityOptions", () => {
  it("preserves password bytes and encryptHeaders for 7z", () => {
    expect(
      normalizeCompressionSecurityOptions("7z", "  secret  ", true),
    ).toEqual({
      password: "  secret  ",
      encryptHeaders: true,
    });
  });

  it("strips encryptHeaders for zip", () => {
    expect(
      normalizeCompressionSecurityOptions("zip", "zip-pass", true),
    ).toEqual({
      password: "zip-pass",
      encryptHeaders: false,
    });
  });

  it("strips password and encryptHeaders for tar", () => {
    expect(
      normalizeCompressionSecurityOptions("tar", "should-drop", true),
    ).toEqual({
      password: "",
      encryptHeaders: false,
    });
  });
});

describe("validateCompressionSecurityOptions", () => {
  it("rejects line breaks because passwords are supplied over a native pipe", () => {
    expect(validateCompressionSecurityOptions("7z", "one\ntwo", false)).toBe(
      "Archive passwords cannot contain line breaks.",
    );
    expect(
      validateCompressionSecurityOptions("7z", "one\u2028two", false),
    ).toBe("Archive passwords cannot contain line breaks.");
    expect(
      validateCompressionSecurityOptions("7z", "one\u0000two", false),
    ).toBe("Archive passwords cannot contain line breaks.");
  });

  it("errors when encryptHeaders set without password on 7z", () => {
    expect(validateCompressionSecurityOptions("7z", "", true)).toBe(
      "Enter a password to enable file-name encryption.",
    );
  });

  it("passes when 7z has password and encryptHeaders", () => {
    expect(validateCompressionSecurityOptions("7z", "secret", true)).toBeNull();
  });

  it("passes for zip with no password and encryptHeaders", () => {
    expect(validateCompressionSecurityOptions("zip", "", true)).toBeNull();
  });
});
