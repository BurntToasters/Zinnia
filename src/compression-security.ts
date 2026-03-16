import type { ArchiveFormat } from "./settings-model.ts";

export interface CompressionSecuritySupport {
  password: boolean;
  encryptHeaders: boolean;
}

const SECURITY_SUPPORT_BY_FORMAT: Record<ArchiveFormat, CompressionSecuritySupport> = {
  "7z": { password: true, encryptHeaders: true },
  "zip": { password: true, encryptHeaders: false },
  "tar": { password: false, encryptHeaders: false },
  "gzip": { password: false, encryptHeaders: false },
  "bzip2": { password: false, encryptHeaders: false },
  "xz": { password: false, encryptHeaders: false },
};

const DEFAULT_SECURITY_SUPPORT: CompressionSecuritySupport = {
  password: false,
  encryptHeaders: false,
};

export function getCompressionSecuritySupport(format: string): CompressionSecuritySupport {
  return SECURITY_SUPPORT_BY_FORMAT[format as ArchiveFormat] ?? DEFAULT_SECURITY_SUPPORT;
}

export function normalizeCompressionSecurityOptions(
  format: string,
  password: string,
  encryptHeaders: boolean
): { password: string; encryptHeaders: boolean } {
  const support = getCompressionSecuritySupport(format);
  return {
    password: support.password ? password.trim() : "",
    encryptHeaders: support.encryptHeaders ? encryptHeaders : false,
  };
}

export function validateCompressionSecurityOptions(
  format: string,
  password: string,
  encryptHeaders: boolean
): string | null {
  const support = getCompressionSecuritySupport(format);
  if (!support.encryptHeaders) return null;
  if (!encryptHeaders) return null;
  if (password.trim()) return null;
  return "Enter a password to enable file-name encryption.";
}
