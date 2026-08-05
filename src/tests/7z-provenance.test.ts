import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("bundled 7-Zip provenance", () => {
  it("maps every tracked binary to a hashed official archive member", () => {
    const root = process.cwd();
    const checksums = JSON.parse(
      fs.readFileSync(
        path.resolve(root, "assets", "7z-checksums.json"),
        "utf8",
      ),
    ) as Record<string, string>;
    const provenance = JSON.parse(
      fs.readFileSync(
        path.resolve(root, "assets", "7z-provenance.json"),
        "utf8",
      ),
    ) as {
      version: string;
      officialDownloadPage: string;
      sourceArchives: Record<string, { url: string; sha256: string }>;
      artifacts: Record<string, { source: string; member: string }>;
    };

    expect(provenance.version).toBe("26.02");
    expect(provenance.officialDownloadPage).toBe(
      "https://www.7-zip.org/download.html",
    );
    expect(Object.keys(provenance.sourceArchives).sort()).toEqual([
      "linux-arm64",
      "linux-x64",
      "mac",
      "windows-arm64-installer",
      "windows-x64-installer",
    ]);
    expect(Object.keys(provenance.artifacts).sort()).toEqual([
      "linux/arm64/7zzs",
      "linux/x64/7zzs",
      "mac/7zz",
      "win/arm64/7z.dll",
      "win/arm64/7z.exe",
      "win/x64/7z.dll",
      "win/x64/7z.exe",
    ]);
    expect(Object.keys(provenance.artifacts).sort()).toEqual(
      Object.keys(checksums).sort(),
    );
    for (const record of Object.values(provenance.artifacts)) {
      expect(record.member).not.toBe("");
      const source = provenance.sourceArchives[record.source];
      expect(source?.url).toMatch(
        /^https:\/\/(?:www\.7-zip\.org\/a\/|github\.com\/ip7z\/7zip\/releases\/download\/)/,
      );
      expect(source?.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("does not retain obsolete standalone or plugin assets", () => {
    const obsolete = [
      "assets/linux/arm64/7zz",
      "assets/linux/x64/7zz",
      "assets/win/arm64/7-ZipFar.dll",
      "assets/win/arm64/7za.dll",
      "assets/win/arm64/7za.exe",
      "assets/win/arm64/7zxa.dll",
      "assets/win/x64/7za.dll",
      "assets/win/x64/7za.exe",
      "assets/win/x64/7zxa.dll",
    ];
    for (const relativePath of obsolete) {
      expect(fs.existsSync(path.resolve(process.cwd(), relativePath))).toBe(
        false,
      );
    }
  });
});
