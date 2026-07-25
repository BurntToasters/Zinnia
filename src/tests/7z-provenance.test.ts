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
    expect(Object.keys(provenance.artifacts).sort()).toEqual(
      Object.keys(checksums).sort(),
    );
    for (const record of Object.values(provenance.artifacts)) {
      expect(record.member).not.toBe("");
      const source = provenance.sourceArchives[record.source];
      expect(source?.url).toMatch(/^https:\/\/www\.7-zip\.org\/a\//);
      expect(source?.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
