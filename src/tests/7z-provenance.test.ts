import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { syncChangelog7zVersion } from "../../scripts/update-7z.js";

describe("7-Zip changelog sync", () => {
  const bullet = "- **7-Zip:** Updated bundled 7-Zip to `26.07`.";

  it("keeps the bullet inside the current release before collapsed history", () => {
    const changelog = [
      "## Changes in `v0.7.0-beta.1:`",
      "",
      "- **Fix:** Something.",
      "",
      "### FULL CHANGELOG:",
      "",
      "<details>",
      "  <summary>Older</summary>",
      "- **7-Zip:** Updated bundled 7-Zip to `26.06`.",
      "",
      "## Changes in `v0.6.0:`",
      "",
      "- **Old:** Entry.",
      "",
    ].join("\n");
    const synced = syncChangelog7zVersion(changelog, "0.7.0-beta.1", "26.07");
    const current = synced.slice(0, synced.indexOf("### FULL CHANGELOG:"));
    expect(current).toBe(
      [
        "## Changes in `v0.7.0-beta.1:`",
        "",
        "- **Fix:** Something.",
        bullet,
        "",
        "",
      ].join("\n"),
    );
    expect(synced.slice(synced.indexOf("### FULL CHANGELOG:"))).toBe(
      changelog.slice(changelog.indexOf("### FULL CHANGELOG:")),
    );
  });

  it("replaces an existing bullet instead of stacking one", () => {
    const changelog = [
      "## Changes in `v0.6.6:`",
      "",
      "- **7-Zip:** Updated bundled 7-Zip to `26.06`.",
      "- **macOS - 7-Zip:** Kept.",
      "",
      "## Changes in `v0.6.5:`",
      "",
      "- **7-Zip:** Updated bundled 7-Zip to `26.05`.",
      "",
    ].join("\n");
    const synced = syncChangelog7zVersion(changelog, "0.6.6", "26.07");
    expect(synced).toBe(
      [
        "## Changes in `v0.6.6:`",
        "",
        "- **macOS - 7-Zip:** Kept.",
        bullet,
        "",
        "## Changes in `v0.6.5:`",
        "",
        "- **7-Zip:** Updated bundled 7-Zip to `26.05`.",
        "",
      ].join("\n"),
    );
  });

  it("handles a final section and CRLF line endings", () => {
    const changelog = "## Changes in `v1.0.0:`\r\n\r\n- **Fix:** One.\r\n";
    expect(syncChangelog7zVersion(changelog, "1.0.0", "26.07")).toBe(
      `## Changes in \`v1.0.0:\`\r\n\r\n- **Fix:** One.\r\n${bullet}\r\n`,
    );
  });
});

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
      artifacts: Record<
        string,
        | { source: string; member: string }
        | { derivedFrom: Record<string, string>; method: string }
      >;
    };

    // build.rs embeds this as the runtime version gate; keep it the only copy.
    expect(provenance.version).toMatch(/^\d+\.\d+$/);
    const compact = provenance.version.replace(".", "");
    for (const source of Object.values(provenance.sourceArchives)) {
      expect(source.url).toContain(`7z${compact}-`);
    }
    expect(provenance.officialDownloadPage).toBe(
      "https://www.7-zip.org/download.html",
    );
    expect(Object.keys(provenance.sourceArchives).sort()).toEqual([
      "linux-arm64",
      "linux-x64",
      "mac-arm64",
      "mac-x64",
      "windows-arm64-installer",
      "windows-x64-installer",
    ]);
    expect(provenance.sourceArchives["mac-arm64"].url).toMatch(
      new RegExp(`/7z${compact}-mac\\.tar\\.xz$`),
    );
    expect(provenance.sourceArchives["mac-x64"].url).toMatch(
      new RegExp(`/7z${compact}-mac-x64\\.tar\\.xz$`),
    );
    expect(Object.keys(provenance.artifacts).sort()).toEqual([
      "linux/arm64/7zzs",
      "linux/x64/7zzs",
      "mac/arm64/7zz",
      "mac/universal/7zz",
      "mac/x64/7zz",
      "win/arm64/7z.dll",
      "win/arm64/7z.exe",
      "win/x64/7z.dll",
      "win/x64/7z.exe",
    ]);
    expect(Object.keys(provenance.artifacts).sort()).toEqual(
      Object.keys(checksums).sort(),
    );
    expect(provenance.artifacts["mac/universal/7zz"]).toEqual({
      derivedFrom: { x86_64: "mac/x64/7zz", arm64: "mac/arm64/7zz" },
      method: "universal-macho",
    });
    for (const record of Object.values(provenance.artifacts)) {
      if ("derivedFrom" in record) {
        for (const input of Object.values(record.derivedFrom)) {
          expect(provenance.artifacts[input]).toHaveProperty("member");
        }
        continue;
      }
      expect(record.member).not.toBe("");
      const source = provenance.sourceArchives[record.source];
      expect(source?.url).toMatch(
        /^https:\/\/(?:www\.7-zip\.org\/a\/|github\.com\/ip7z\/7zip\/releases\/download\/)/,
      );
      expect(source?.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("tracks every bundled Unix 7-Zip binary as executable in git", () => {
    const checksums = JSON.parse(
      fs.readFileSync(
        path.resolve(process.cwd(), "assets", "7z-checksums.json"),
        "utf8",
      ),
    ) as Record<string, string>;
    const unixBinaries = Object.keys(checksums)
      .filter((asset) => /\/7zzs?$/.test(asset))
      .map((asset) => `assets/${asset}`)
      .sort();
    expect(unixBinaries.length).toBeGreaterThanOrEqual(5);
    const modes = Object.fromEntries(
      execFileSync("git", ["ls-files", "-s", "--", ...unixBinaries], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .map((line) => {
          const [meta, file] = line.split("\t");
          return [file, meta.split(" ")[0]];
        }),
    );
    expect(Object.keys(modes).sort()).toEqual(unixBinaries);
    for (const file of unixBinaries) {
      expect(modes[file], file).toBe("100755");
    }
  });

  it("does not retain obsolete standalone or plugin assets", () => {
    const obsolete = [
      "assets/linux/arm64/7zz",
      "assets/linux/x64/7zz",
      "assets/mac/7zz",
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
