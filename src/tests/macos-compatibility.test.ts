import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  macBundleVersionFromSemver,
  macMarketingVersionFromSemver,
} from "../../scripts/sync-version-helpers.js";

describe("macOS compatibility", () => {
  it("requires macOS 26+ and a numeric bundle build version", () => {
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

    expect(config.bundle?.macOS?.minimumSystemVersion).toBe("26.0");
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
  });

  it.runIf(process.platform === "darwin")(
    "keeps every official 7-Zip slice compatible with the declared macOS floor",
    () => {
      const sidecar = path.resolve(process.cwd(), "assets", "mac", "7zz");
      for (const arch of ["x86_64", "arm64"]) {
        const output = execFileSync("otool", ["-arch", arch, "-l", sidecar], {
          encoding: "utf8",
        });
        const match = output.match(/\bminos\s+(\d+(?:\.\d+)*)/);
        expect(match?.[1]).toBe("26.0");
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

  it("replaces the live app with a sibling backup instead of rm -rf before mv", () => {
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
    expect(script).toContain('/bin/mv -f \\"$BAK\\" \\"$SRC\\"');
    expect(script).toContain('/bin/test -d \\"$SRC/Contents\\"');
    expect(script).toContain(
      '/bin/rm -rf \\"$SRC\\"; fi; /bin/mv -f \\"$BAK\\" \\"$SRC\\"',
    );
    expect(script).not.toContain('rm -rf " & quoted form of srcPath');
    expect(script).toContain(
      'if /bin/test -e \\"$BAK\\"; then /bin/rm -rf \\"$BAK\\"; fi; /bin/mv -f \\"$SRC\\" \\"$BAK\\"',
    );
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
    const productionInstall = installInner.split("#[cfg(test)]")[0];
    expect(productionInstall).not.toMatch(/rm -rf .*quoted form of srcPath/);
  });
});
