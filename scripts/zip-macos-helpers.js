/**
 * Helpers for macOS release packaging checks. Kept separate from zip-macos.js
 * so Vitest can exercise the App Group Mach-O gate without requiring darwin.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Mach-O fat magic (big-endian) and byte-swapped variant. */
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;

/**
 * True when the binary contains the exact UTF-8 needle (e.g. baked
 * `ZINNIA_APP_GROUP_ID` from build.rs).
 *
 * @param {string | Buffer} binary
 * @param {string} needle
 */
export function binaryContainsUtf8String(binary, needle) {
  if (!needle) return false;
  const buffer = Buffer.isBuffer(binary) ? binary : Buffer.from(binary);
  return buffer.includes(Buffer.from(needle, "utf8"));
}

/**
 * @param {Buffer} buffer
 */
export function isFatMachO(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const magic = buffer.readUInt32BE(0);
  return magic === FAT_MAGIC || magic === FAT_CIGAM;
}

/**
 * @param {string} binaryPath
 * @returns {string[]}
 */
export function listMachOArchitectures(binaryPath) {
  try {
    const output = execFileSync("lipo", ["-archs", binaryPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.trim().split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * @param {string | Buffer} binary
 * @param {string} expectedGroup
 * @param {string} [label]
 */
export function assertBinaryContainsAppGroup(
  binary,
  expectedGroup,
  label = "Host binary",
) {
  if (!binaryContainsUtf8String(binary, expectedGroup)) {
    throw new Error(
      `${label} is missing baked App Group ${expectedGroup}. Rebuild with APPLE_TEAM_ID matching the signing identity.`,
    );
  }
}

/**
 * Universal macOS binaries must bake the App Group on every slice. Scanning the
 * fat file once can miss a stale `group.run…` fallback on one architecture.
 *
 * @param {string} binaryPath
 * @param {string} expectedGroup
 * @param {string} [label]
 */
export function assertUniversalBinaryContainsAppGroup(
  binaryPath,
  expectedGroup,
  label = "Host binary",
) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "zinnia-app-group-"),
  );
  try {
    const whole = fs.readFileSync(binaryPath);
    const listedArches = listMachOArchitectures(binaryPath);
    const arches = listedArches.length > 0 ? listedArches : ["x86_64", "arm64"];
    let checked = 0;
    for (const arch of arches) {
      const thinPath = path.join(temporaryDirectory, `${arch}-thin`);
      try {
        execFileSync("lipo", ["-thin", arch, "-output", thinPath, binaryPath], {
          stdio: "pipe",
        });
      } catch {
        if (listedArches.length > 0) {
          throw new Error(
            `${label} lists architecture ${arch} but lipo could not thin it for App Group verification.`,
          );
        }
        // Fallback probe of common arches when lipo -archs is unavailable.
        continue;
      }
      assertBinaryContainsAppGroup(
        fs.readFileSync(thinPath),
        expectedGroup,
        `${label} (${arch})`,
      );
      checked += 1;
    }
    if (checked === 0) {
      // Fat binaries require a per-slice check. Falling back to a whole-file
      // scan would pass when only one architecture baked the App Group.
      if (isFatMachO(whole)) {
        throw new Error(
          `${label} is a universal Mach-O but lipo could not thin any slice for App Group verification. Install Xcode command-line tools (lipo) on release builders.`,
        );
      }
      assertBinaryContainsAppGroup(whole, expectedGroup, label);
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
