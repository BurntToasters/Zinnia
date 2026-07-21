import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const validator = path.join(root, "scripts", "validate-updater-manifest.js");

function envelopeForAlgorithm(algorithm: "Ed" | "ED"): string {
  const packet = Buffer.alloc(74, 0);
  packet[0] = 0x45;
  packet[1] = algorithm === "ED" ? 0x44 : 0x64;
  const globalSignature = Buffer.alloc(64, 1);
  const text = [
    "untrusted comment: signature from minisign secret key",
    packet.toString("base64"),
    "trusted comment: timestamp:0\tfile:test\tprehashed",
    globalSignature.toString("base64"),
    "",
  ].join("\n");
  return Buffer.from(text, "utf8").toString("base64");
}

function writeManifest(signature: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zinnia-updater-"));
  const file = path.join(directory, "latest-darwin-aarch64.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: "0.6.0-beta.4",
      pub_date: "2026-07-20T00:00:00Z",
      platforms: {
        "darwin-aarch64": {
          url: "https://github.com/BurntToasters/Zinnia/releases/download/v0.6.0-beta.4/Zinnia.app.tar.gz",
          signature,
        },
      },
    }),
  );
  return file;
}

function runValidator(file: string) {
  try {
    return spawnSync(process.execPath, [validator, file], {
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

describe("validate-updater-manifest signatures", () => {
  it("accepts legacy Ed and Tauri prehashed ED envelopes", () => {
    for (const algorithm of ["Ed", "ED"] as const) {
      const result = runValidator(
        writeManifest(envelopeForAlgorithm(algorithm)),
      );
      expect(result.status, result.stderr || result.stdout).toBe(0);
    }
  });

  it("rejects a non-minisign signature blob", () => {
    const result = runValidator(
      writeManifest(Buffer.from("not-a-minisign").toString("base64")),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/base64-encoded minisign envelope/);
  });
});
