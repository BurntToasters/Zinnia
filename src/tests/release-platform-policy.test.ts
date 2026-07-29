import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isChecksumTextName,
  requiredLinuxTargetKeys,
} from "../../scripts/gpg-sign.js";

const read = (file: string) =>
  fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("cross-platform release policy", () => {
  it("smoke-builds every supported desktop CPU family", () => {
    const ci = read(".github/workflows/ci.yml");
    for (const runner of [
      "ubuntu-latest",
      "ubuntu-24.04-arm",
      "macos-26",
      "macos-26-intel",
      "windows-latest",
      "windows-11-arm",
    ]) {
      expect(ci).toContain(`os: ${runner}`);
    }
    expect(ci).toContain("Compile Finder Sync extension smoke");
    expect(ci).toContain("Native Windows shell compile smoke");
    expect(ci).toContain("'msix_identity', 'msix_extract_identity'");
  });

  it("requires present Linux architectures without blocking other platform signers", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["release:linux:continue"]).toBe(
      "npm run release:linux:x64:continue",
    );
    expect(packageJson.scripts["build:linux"]).toBe("npm run build:linux:x64");
    expect(packageJson.scripts["build:linux:prepared"]).toBe(
      "npm run build:linux:x64:prepared",
    );
    const signer = read("scripts/gpg-sign.js");
    expect(signer).toContain('REQUIRED_LINUX_TARGETS || ""');
    expect(signer).toContain(
      "isExplicitTruthy(\n  process.env.REQUIRE_LINUX_AARCH64",
    );
    expect(signer).toContain("requiredLinuxTargetKeys(");
    expect(signer).toContain(
      'if (target.os === "linux") tokens.push(target.arch)',
    );
    expect(signer).toContain("latest-${installerKey}.json");
    const live = read("scripts/validate-updater-live.js");
    expect(live).toContain('"linux-beta-aarch64-appimage"');
    expect(live).toContain('"linux-beta-x86_64-deb"');
    expect(live).toContain("EXPECTED_UPDATER_VERSION");
    expect(live).toContain("REQUIRED_UPDATER_TARGETS");
    expect(packageJson.scripts["release:verify:published"]).toContain(
      "--expected-version=current",
    );
  });

  it("scopes automatic Linux updater requirements to the current signing session", () => {
    const channels = [
      { targetSuffix: "", baseUrl: "stable" },
      { targetSuffix: "-beta", baseUrl: "beta" },
    ];
    expect(
      requiredLinuxTargetKeys(
        channels,
        new Map([["Zinnia-Windows-x64.exe", "/tmp/windows"]]),
      ),
    ).toEqual(new Set());
    expect(
      requiredLinuxTargetKeys(
        channels,
        new Map([["Zinnia-Linux-arm64.deb", "/tmp/linux"]]),
      ),
    ).toEqual(new Set(["linux-aarch64", "linux-beta-aarch64"]));
  });

  it("grants Flatpak access to common removable-media mount roots", () => {
    const manifest = read("run.rosie.zinnia.yml");
    expect(manifest).toContain("--filesystem=/run/media");
    expect(manifest).toContain("--filesystem=/media");
    expect(manifest).toContain("--filesystem=/mnt");
  });

  it("uploads checksum manifests for prerelease target keys", () => {
    expect(isChecksumTextName("SHA256SUMS-windows-beta-x86_64.txt")).toBe(true);
    expect(isChecksumTextName("SHA256SUMS-darwin-beta-aarch64.txt")).toBe(true);
  });
});
