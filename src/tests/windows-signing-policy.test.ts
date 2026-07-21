import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows signing identity policy", () => {
  for (const script of [
    "windows-artifact-sign.ps1",
    "verify-windows-authenticode.ps1",
  ]) {
    it(`${script} verifies the full certificate Subject`, () => {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), "scripts", script),
        "utf8",
      );
      expect(source).toContain("AZURE_ARTIFACT_SIGNING_PUBLISHER_DN");
      expect(source).toContain("SignerCertificate.Subject.Trim()");
      expect(source).toContain("expectedSubject");
      expect(source).toContain("TimeStamperCertificate");
    });
  }
});
