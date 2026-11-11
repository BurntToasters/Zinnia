import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compareVersions } from "../version-compare";
import {
  macBundleVersionFromSemver,
  macMarketingVersionFromSemver,
} from "../../scripts/sync-version-helpers.js";
import {
  buildUniversalMachO,
  readThinMachOArch,
} from "../../scripts/prepare-7z-helpers.js";

const MAC_7Z_SLICES = [
  ["x64", "x86_64"],
  ["arm64", "arm64"],
] as const;

const CPU_TYPES = { x86_64: 0x01000007, arm64: 0x0100000c } as const;

function thinMachO(cpuType: number, body: string, magic = 0xfeedfacf): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(magic, 0);
  header.writeUInt32LE(cpuType, 4);
  header.writeUInt32LE(cpuType === CPU_TYPES.x86_64 ? 3 : 0, 8);
  header.writeUInt32LE(2, 12);
  return Buffer.concat([header, Buffer.from(body)]);
}

function readMacAsset(dir: string): Buffer {
  return fs.readFileSync(
    path.resolve(process.cwd(), "assets", "mac", dir, "7zz"),
  );
}

describe("universal macOS 7-Zip merge", () => {
  const x64 = thinMachO(CPU_TYPES.x86_64, "x86_64 slice body");
  const arm64 = thinMachO(CPU_TYPES.arm64, "arm64 slice body, a bit longer");

  it("rejects inputs that are not thin 64-bit Mach-O files", () => {
    expect(() => readThinMachOArch(Buffer.alloc(0))).toThrow(/Mach-O/);
    expect(() =>
      readThinMachOArch(Buffer.from("not a binary at all, nope")),
    ).toThrow(/Mach-O/);
    expect(() =>
      readThinMachOArch(thinMachO(CPU_TYPES.x86_64, "x", 0xfeedface)),
    ).toThrow(/Mach-O/);
    const fat = buildUniversalMachO({ x86_64: x64, arm64 });
    expect(() => readThinMachOArch(fat)).toThrow(/Mach-O/);
    expect(() =>
      readThinMachOArch(thinMachO(0x00000007, "i386 cpu type")),
    ).toThrow(/architecture/);
  });

  it("rejects a slice placed under the wrong architecture", () => {
    expect(() => buildUniversalMachO({ x86_64: arm64, arm64 })).toThrow(
      /x86_64/,
    );
    expect(() => buildUniversalMachO({ x86_64: x64, arm64: x64 })).toThrow(
      /arm64/,
    );
    expect(() => buildUniversalMachO({ x86_64: x64 } as never)).toThrow(
      /arm64/,
    );
  });

  it("writes an aligned big-endian fat header that preserves slice bytes", () => {
    const fat = buildUniversalMachO({ x86_64: x64, arm64 });
    expect(fat.readUInt32BE(0)).toBe(0xcafebabe);
    expect(fat.readUInt32BE(4)).toBe(2);
    const slices = [0, 1].map((index) => {
      const offset = 8 + index * 20;
      return {
        cpuType: fat.readUInt32BE(offset),
        cpuSubtype: fat.readUInt32BE(offset + 4),
        offset: fat.readUInt32BE(offset + 8),
        size: fat.readUInt32BE(offset + 12),
        align: fat.readUInt32BE(offset + 16),
      };
    });
    expect(slices.map((slice) => slice.cpuType)).toEqual([
      CPU_TYPES.x86_64,
      CPU_TYPES.arm64,
    ]);
    expect(slices[0].cpuSubtype).toBe(3);
    for (const [slice, source] of [
      [slices[0], x64],
      [slices[1], arm64],
    ] as const) {
      expect(slice.offset % 2 ** slice.align).toBe(0);
      expect(slice.align).toBeGreaterThanOrEqual(12);
      expect(slice.size).toBe(source.length);
      expect(
        fat.subarray(slice.offset, slice.offset + slice.size).equals(source),
      ).toBe(true);
    }
    expect(slices[1].align).toBe(14);
    expect(slices[1].offset).toBeGreaterThanOrEqual(
      slices[0].offset + slices[0].size,
    );
    expect(fat.length).toBe(slices[1].offset + slices[1].size);
  });

  it("is deterministic", () => {
    expect(
      buildUniversalMachO({ x86_64: x64, arm64 }).equals(
        buildUniversalMachO({ x86_64: x64, arm64 }),
      ),
    ).toBe(true);
  });

  it("matches the committed universal asset built from the official slices", () => {
    const rebuilt = buildUniversalMachO({
      x86_64: readMacAsset("x64"),
      arm64: readMacAsset("arm64"),
    });
    expect(rebuilt.equals(readMacAsset("universal"))).toBe(true);
  });

  it.runIf(process.platform === "darwin")(
    "produces a universal 7zz that lipo, codesign, and the host CPU accept",
    () => {
      const provenance = JSON.parse(
        fs.readFileSync(
          path.resolve(process.cwd(), "assets", "7z-provenance.json"),
          "utf8",
        ),
      ) as { version: string };
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "zinnia-7zz-fat-"));
      try {
        const universal = path.join(workDir, "7zz");
        fs.copyFileSync(
          path.resolve(process.cwd(), "assets", "mac", "universal", "7zz"),
          universal,
        );
        fs.chmodSync(universal, 0o755);
        expect(
          execFileSync("lipo", ["-archs", universal], { encoding: "utf8" })
            .trim()
            .split(/\s+/)
            .sort(),
        ).toEqual(["arm64", "x86_64"]);
        for (const [dir, arch] of MAC_7Z_SLICES) {
          const thinned = path.join(workDir, `7zz-${arch}`);
          execFileSync("lipo", [universal, "-thin", arch, "-output", thinned]);
          expect(fs.readFileSync(thinned).equals(readMacAsset(dir))).toBe(true);
        }
        execFileSync("codesign", ["--force", "--sign", "-", universal]);
        execFileSync("codesign", ["--verify", "--verbose=2", universal]);
        const banner = execFileSync(universal, ["i"], { encoding: "utf8" });
        expect(banner).toContain(`7-Zip (z) ${provenance.version}`);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("macOS compatibility", () => {
  // Compatibility failure modes to guard before changing the deployment floor:
  // - the host app remains above or below the advertised macOS 15.0 minimum;
  // - the Finder Sync source plist disagrees with the host app minimum;
  // - the extension compiler target and generated plist diverge, especially
  //   when ZINNIA_FINDERSYNC_MIN_OS overrides the config-derived default;
  // - a shipped 7-Zip architecture still requires a newer macOS release.
  it("requires macOS 15+ and a numeric bundle build version", () => {
    const config = JSON.parse(
      fs.readFileSync(
        path.resolve(process.cwd(), "src-tauri", "tauri.conf.json"),
        "utf8",
      ),
    ) as {
      version?: string;
      bundle?: {
        macOS?: { minimumSystemVersion?: string; bundleVersion?: string };
      };
    };

    expect(config.bundle?.macOS?.minimumSystemVersion).toBe("15.0");
    expect(config.bundle?.macOS?.bundleVersion).toMatch(/^\d+(?:\.\d+){0,2}$/);
    expect(config.bundle?.macOS?.bundleVersion).toBe(
      macBundleVersionFromSemver(config.version ?? ""),
    );
    const infoPlist = fs.readFileSync(
      path.resolve(process.cwd(), "src-tauri", "Info.plist"),
      "utf8",
    );
    expect(infoPlist).toContain(
      `<string>${macMarketingVersionFromSemver(config.version ?? "")}</string>`,
    );
    expect(infoPlist).toContain("run.rosie.zinnia.split-volume");
    expect(infoPlist).toContain("<string>001</string>");
    expect(infoPlist).toContain("Extract with Zinnia");

    const finderSyncInfoPlist = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src-tauri",
        "macos",
        "ZinniaFinderSync",
        "Info.plist",
      ),
      "utf8",
    );
    expect(finderSyncInfoPlist).toContain(
      "<key>LSMinimumSystemVersion</key>\n\t<string>15.0</string>",
    );
  });

  it("links the Finder Sync compiler target and generated plist to the effective minimum", () => {
    const finderSyncBuildScript = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "build-macos-finder-sync.sh"),
      "utf8",
    );
    expect(finderSyncBuildScript).toContain(
      "ZINNIA_FINDERSYNC_MIN_OS:-$(node -e",
    );
    expect(finderSyncBuildScript).toContain("src-tauri/tauri.conf.json");
    expect(finderSyncBuildScript).toContain(
      "config.bundle?.macOS?.minimumSystemVersion",
    );
    expect(finderSyncBuildScript).toContain(
      "Set :LSMinimumSystemVersion $MIN_OS",
    );
    expect(finderSyncBuildScript).toContain(
      '-target "${arch}-apple-macosx${MIN_OS}"',
    );
  });

  it("stores each official macOS 7-Zip slice as its own thin Mach-O", () => {
    for (const [dir, arch] of MAC_7Z_SLICES) {
      const bytes = fs.readFileSync(
        path.resolve(process.cwd(), "assets", "mac", dir, "7zz"),
      );
      expect(readThinMachOArch(bytes), `assets/mac/${dir}/7zz`).toBe(arch);
    }
    expect(
      fs.existsSync(path.resolve(process.cwd(), "assets", "mac", "7zz")),
    ).toBe(false);
  });

  it("stores each official macOS 7-Zip slice as its own thin Mach-O", () => {
    for (const [dir, arch] of MAC_7Z_SLICES) {
      const bytes = fs.readFileSync(
        path.resolve(process.cwd(), "assets", "mac", dir, "7zz"),
      );
      expect(readThinMachOArch(bytes), `assets/mac/${dir}/7zz`).toBe(arch);
    }
    expect(
      fs.existsSync(path.resolve(process.cwd(), "assets", "mac", "7zz")),
    ).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "keeps every official 7-Zip slice compatible with the declared macOS floor",
    () => {
      const config = JSON.parse(
        fs.readFileSync(
          path.resolve(process.cwd(), "src-tauri", "tauri.conf.json"),
          "utf8",
        ),
      );
      const requiredMacOS = config.bundle.macOS.minimumSystemVersion;
      for (const [dir, arch] of MAC_7Z_SLICES) {
        const sidecar = path.resolve(
          process.cwd(),
          "assets",
          "mac",
          dir,
          "7zz",
        );
        const output = execFileSync("otool", ["-arch", arch, "-l", sidecar], {
          encoding: "utf8",
        });
        const match = output.match(/\bminos\s+(\d+(?:\.\d+)*)/);
        expect(match, `Missing minos for ${arch}`).not.toBeNull();
        expect(
          compareVersions(match![1], requiredMacOS),
          `${arch} minimum macOS must not exceed ${requiredMacOS}`,
        ).toBeLessThanOrEqual(0);
      }
    },
    // Two synchronous `execFileSync` spawns are fast in isolation (tens of
    // ms) but can occasionally exceed vitest's 5s default under the full
    // suite's ~55 concurrent jsdom worker load, since this is one of the few
    // tests that shells out to a real subprocess rather than only doing
    // in-process work. This gate feeds npm run test:all's release
    // quality-gate proof, so a load-induced timeout here must not be able to
    // block an otherwise-clean release run.
    30_000,
  );

  it("uses modern default-application APIs", () => {
    const platformSource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src-tauri",
        "src",
        "platform",
        "macos_defaults.rs",
      ),
      "utf8",
    );
    expect(platformSource).toContain(
      "setDefaultApplicationAtURL_toOpenContentType_completionHandler",
    );
    expect(platformSource).toContain("URLForApplicationToOpenContentType");
    expect(platformSource).not.toMatch(
      /LSSetDefaultRoleHandlerForContentType|LSCopyDefaultRoleHandlerForContentType|UTTypeCreatePreferredIdentifierForTag/,
    );
  });

  it("keeps the runtime entitlement surface exact and release-verified", () => {
    const entitlements = fs.readFileSync(
      path.resolve(process.cwd(), "src-tauri", "entitlements.plist"),
      "utf8",
    );
    const releaseVerifier = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "zip-macos.js"),
      "utf8",
    );
    expect(entitlements).toContain("com.apple.security.cs.allow-jit");
    expect(entitlements).not.toContain("com.apple.security.network.client");
    expect(entitlements).not.toContain("com.apple.security.get-task-allow");
    expect(releaseVerifier).toContain("verifySignedEntitlements(appPath");
    expect(releaseVerifier).toContain("verifySignedEntitlements(sidecarPath");
    expect(releaseVerifier).toContain('"--xml"');
    expect(releaseVerifier).toContain("const hostEntitlements");
    expect(releaseVerifier).toContain("ZinniaFinderSync.entitlements");
    expect(releaseVerifier).toContain("Zinnia.entitlements");
    expect(releaseVerifier).toContain(
      'path.join(finderSyncAppex, "Contents", "MacOS", "ZinniaFinderSync")',
    );
    expect(releaseVerifier).toContain("verifyMachOCompatibility");
    expect(releaseVerifier).toContain("TeamIdentifier");
    expect(releaseVerifier).toContain("expectedAppGroup");
    expect(releaseVerifier).toContain("hostTeam !== extensionTeam");
    expect(releaseVerifier).toContain("sidecarTeam !== hostTeam");
  });

  it("uses an App Group instead of sandbox-incompatible Finder Sync launch arguments", () => {
    const finderSync = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src-tauri",
        "macos",
        "ZinniaFinderSync",
        "FinderSync.swift",
      ),
      "utf8",
    );
    const finderSyncPlist = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src-tauri",
        "macos",
        "ZinniaFinderSync",
        "Info.plist",
      ),
      "utf8",
    );
    expect(finderSync).toContain("containerURL(");
    expect(finderSync).toContain("FinderSyncRequests");
    expect(finderSync).toContain("createdAtMs");
    expect(finderSync).toContain("1,000-item safety limit");
    expect(finderSync).toContain("supports selections of up to 1,000 items");
    expect(finderSync).toContain("mountedVolumeURLs");
    expect(finderSync).toContain("didMountNotification");
    expect(finderSync).toContain("didUnmountNotification");
    expect(finderSync).toContain("volumeIsRootFileSystem");
    expect(finderSync).not.toContain('fileURLWithPath: "/Volumes"');
    expect(finderSync).toContain("embeddedExtension");
    expect(finderSync).toContain(
      "archiveExtensions.contains(embeddedExtension)",
    );
    expect(finderSync).not.toContain('fileURLWithPath: "/", isDirectory: true');
    expect(finderSync).not.toContain("configuration.arguments");
    expect(finderSyncPlist).toContain("NSExtensionAttributes");
    expect(finderSyncPlist).toContain("ZinniaAppGroupIdentifier");
  });

  it("preserves the outer app directory while backing up and replacing Contents", () => {
    const updaterSrc = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src-tauri",
        "vendor",
        "tauri-plugin-updater",
        "src",
        "install_safety.rs",
      ),
      "utf8",
    );
    expect(updaterSrc).toContain("MACOS_PRIVILEGED_INSTALL_SCRIPT");
    expect(updaterSrc).toContain("quoted form of");
    expect(updaterSrc).toContain(".zinnia-update-backup");
    const script = updaterSrc.slice(
      updaterSrc.indexOf("on installUpdate"),
      updaterSrc.indexOf("end installUpdate"),
    );
    expect(script).toContain(
      '/bin/mv -f \\\"$BAK/Contents\\\" \\\"$SRC/Contents\\\"',
    );
    expect(script).toContain('/bin/test -d \\\"$SRC/Contents\\\"');
    expect(script).toContain(
      '/bin/mv -f \\\"$SRC/Contents\\\" \\\"$BAK/Contents\\\"',
    );
    expect(script).not.toContain('/bin/mv -f \\\"$SRC\\\" \\\"$BAK\\\"');
    expect(script).not.toContain('rm -rf " & quoted form of srcPath');
    const installInner = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src-tauri",
        "vendor",
        "tauri-plugin-updater",
        "src",
        "updater.rs",
      ),
      "utf8",
    );
    expect(installInner).toContain("MACOS_PRIVILEGED_INSTALL_SCRIPT");
    expect(installInner).toContain("install_macos_app_contents(");
    expect(installInner).not.toContain(
      "std::fs::rename(&self.extract_path, &backup_path)",
    );
    const productionInstall = installInner.split("#[cfg(test)]")[0];
    expect(productionInstall).not.toMatch(/rm -rf .*quoted form of srcPath/);
    expect(productionInstall).not.toContain("script.compile().expect");
    expect(productionInstall).not.toContain("rx.recv().unwrap");
    expect(productionInstall).not.toContain("tx.send(r).unwrap");
    expect(productionInstall).toContain(
      "Privileged macOS update callback did not complete",
    );
  });
});
