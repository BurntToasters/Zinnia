import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  artifactMatchesVersion,
  buildUploadList,
  checksumTargetKeysForArtifactName,
  expectedPublishedBetaManifestNames,
  isExplicitTruthy,
  listAllGithubPages,
  requiredPublishedBetaManifestNames,
  rpmArtifactMatchesVersion,
  updaterChannelVariants,
  validatePublishedBetaManifest,
} from "../../scripts/gpg-sign.js";
import { isDirectExecution as isGitPruneDirectExecution } from "../../scripts/git-prune-local-branches.js";
import {
  officialArchiveExtractionCommand,
  validateTrusted7zPath,
} from "../../scripts/prepare-7z-helpers.js";
import { githubAuthorizationForUrl } from "../../scripts/updater-live-helpers.js";
import {
  assertBinaryContainsAppGroup,
  assertUniversalBinaryContainsAppGroup,
  binaryContainsUtf8String,
  isFatMachO,
} from "../../scripts/zip-macos-helpers.js";

const require = createRequire(import.meta.url);
const {
  assertReleaseTargetsCommit: assertReleaseTargetsCommitCjs,
  listAllGithubPages: listAllGithubPagesCjs,
  resolveGithubToken,
  verifyReleaseSession,
} = require("../../scripts/ensure-draft-release.cjs") as {
  assertReleaseTargetsCommit: (
    release: { target_commitish?: string },
    commit: string,
  ) => unknown;
  listAllGithubPages: typeof listAllGithubPages;
  resolveGithubToken: (env?: NodeJS.ProcessEnv) => string | undefined;
  verifyReleaseSession: (run?: typeof spawnSync) => void;
};

const unsupportedHardLinkErrors = new Set([
  "EACCES",
  "EMLINK",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
  "EROFS",
  "EXDEV",
]);

function supportsHardLinksInTemporaryDirectory(): boolean {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "zinnia-hard-link-probe-"),
  );
  try {
    const source = path.join(temporaryRoot, "source");
    fs.writeFileSync(source, "probe");
    fs.linkSync(source, path.join(temporaryRoot, "link"));
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      unsupportedHardLinkErrors.has(error.code)
    ) {
      return false;
    }
    throw error;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const hardLinksSupported = supportsHardLinksInTemporaryDirectory();

describe("release script safeguards", () => {
  it("binds release drafts to exact checked-out commit", () => {
    const commit = "a".repeat(40);
    expect(() =>
      assertReleaseTargetsCommitCjs({ target_commitish: "main" }, commit),
    ).toThrow("not checked-out commit");
    expect(
      assertReleaseTargetsCommitCjs({ target_commitish: commit }, commit),
    ).toEqual({ target_commitish: commit });

    const gpgSource = fs.readFileSync("scripts/gpg-sign.js", "utf8");
    const draftSource = fs.readFileSync(
      "scripts/ensure-draft-release.cjs",
      "utf8",
    );
    expect(gpgSource).toContain("target_commitish: commit");
    expect(gpgSource).toContain("assertReleaseTargetsCommit");
    expect(draftSource).toMatch(
      /if \(afterRetry\) \{\s*assertReleaseTargetsCommit\(afterRetry, commit\);/,
    );
  });
  it("publishes beta-target updater manifests for stable and beta releases", () => {
    const expected = [
      { targetSuffix: "", baseUrl: "release" },
      { targetSuffix: "-beta", baseUrl: "tag" },
    ];
    expect(updaterChannelVariants(false, "release", "tag")).toEqual(expected);
    expect(updaterChannelVariants(true, "release", "tag")).toEqual(expected);
  });

  it.each([
    "zinnia-0.6.0.rpm",
    "zinnia-0.6.0.rpm.sig",
    "zinnia-0.6.0-1.x86_64.rpm",
    "zinnia-0.6.0-1.fc40.x86_64.rpm",
    "zinnia-0.6.0-0.1.el9.aarch64.rpm",
    "zinnia-0.6.0-1.2.3.riscv64.rpm",
    "zinnia_0.6.0-2_noarch.rpm.sig",
  ])("accepts stable RPM version and packaging suffixes: %s", (name) => {
    expect(rpmArtifactMatchesVersion(name, "0.6.0")).toBe(true);
    expect(artifactMatchesVersion(name, "0.6.0")).toBe(true);
  });

  it.each([
    "zinnia-0.6.0-beta.22-1.x86_64.rpm",
    "zinnia-0.6.0_beta.22-1.x86_64.rpm",
    "zinnia-0.6.0~beta.22-1.fc40.x86_64.rpm",
    "zinnia-0.6.0.beta.22-0.1.aarch64.rpm.sig",
  ])("accepts beta RPM version encodings: %s", (name) => {
    expect(rpmArtifactMatchesVersion(name, "0.6.0-beta.22")).toBe(true);
    expect(artifactMatchesVersion(name, "0.6.0-beta.22")).toBe(true);
  });

  it.each([
    "zinnia-0.6.0-beta.22.rpm",
    "zinnia-0.6.0_beta.22-1.x86_64.rpm",
    "zinnia-0.6.0~beta.22-1.fc40.x86_64.rpm.sig",
    "zinnia-0.6.0.beta.22-0.1.aarch64.rpm",
  ])("rejects sanitized beta RPM names for stable releases: %s", (name) => {
    expect(rpmArtifactMatchesVersion(name, "0.6.0")).toBe(false);
    expect(artifactMatchesVersion(name, "0.6.0")).toBe(false);
  });

  it.each([
    ["zinnia-0.5.9-1.x86_64.rpm", "0.6.0"],
    ["zinnia-0.6.0_beta.21-1.x86_64.rpm", "0.6.0-beta.22"],
    ["zinnia-0.6.1-beta.22-1.x86_64.rpm.sig", "0.6.0-beta.22"],
    ["zinnia-0.6.0-1.x86_64.rpm", "0.6.0-beta.22"],
  ])("rejects stale or wrong-channel RPM %s for %s", (name, version) => {
    expect(rpmArtifactMatchesVersion(name, version)).toBe(false);
    expect(artifactMatchesVersion(name, version)).toBe(false);
  });

  it("keeps non-RPM stale artifact rejection strict", () => {
    expect(
      artifactMatchesVersion("zinnia_0.6.0-beta.22_amd64.deb", "0.6.0"),
    ).toBe(false);
    expect(
      artifactMatchesVersion("zinnia_0.6.0-beta.22_amd64.deb", "0.6.0-beta.22"),
    ).toBe(true);
  });

  it("routes stable installers, signatures, and manifests through shared channels", () => {
    const channels = updaterChannelVariants(false, "release", "tag");
    const installer = "Zinnia-Linux-x64.rpm";
    const signature = `${installer}.sig`;
    const stableManifest = "latest-linux-x86_64.json";
    const betaManifest = "latest-linux-beta-x86_64.json";

    expect(checksumTargetKeysForArtifactName(installer, channels)).toEqual([
      "linux-x86_64",
      "linux-beta-x86_64",
    ]);
    expect(checksumTargetKeysForArtifactName(signature, channels)).toEqual([
      "linux-x86_64",
      "linux-beta-x86_64",
    ]);
    expect(checksumTargetKeysForArtifactName(stableManifest, channels)).toEqual(
      ["linux-x86_64"],
    );
    expect(checksumTargetKeysForArtifactName(betaManifest, channels)).toEqual([
      "linux-beta-x86_64",
    ]);

    const betaBucketMembers = [
      installer,
      signature,
      stableManifest,
      betaManifest,
    ].filter((name) =>
      checksumTargetKeysForArtifactName(name, channels).includes(
        "linux-beta-x86_64",
      ),
    );
    expect(betaBucketMembers).toEqual([installer, signature, betaManifest]);
  });

  it("builds uploads only from the explicitly vetted lists", () => {
    const stagingDirectory = path.resolve("/tmp/zinnia-release");
    const artifact = path.join(stagingDirectory, "Zinnia-Windows-x64.exe");
    const manifest = path.join(
      stagingDirectory,
      "latest-windows-beta-x86_64.json",
    );
    const checksum = path.join(
      stagingDirectory,
      "SHA256SUMS-windows-beta-x86_64.txt",
    );
    const signature = `${artifact}.asc`;
    expect(
      buildUploadList({
        artifacts: [artifact, manifest],
        checksumFiles: [checksum],
        signatureFiles: [signature],
        stagingDirectory,
      }),
    ).toEqual([artifact, manifest, checksum, signature]);
    expect(
      buildUploadList({
        artifacts: [artifact],
        checksumFiles: [],
        signatureFiles: [],
        stagingDirectory,
      }),
    ).not.toContain(path.join(stagingDirectory, "stale.dmg"));
    expect(() =>
      buildUploadList({
        artifacts: [artifact],
        checksumFiles: [],
        signatureFiles: [path.join(stagingDirectory, "stale.dmg.asc")],
        stagingDirectory,
      }),
    ).toThrow(/unvetted release upload/);
  });

  it("enables destructive flags only for explicit truthy values", () => {
    for (const value of ["1", "true", "YES", "on"]) {
      expect(isExplicitTruthy(value)).toBe(true);
    }
    for (const value of ["", "0", "false", "treu", "enabled", undefined]) {
      expect(isExplicitTruthy(value)).toBe(false);
    }
  });

  it("resolves GitHub tokens from GH_TOKEN or GITHUB_TOKEN", () => {
    expect(resolveGithubToken({ GH_TOKEN: "from-gh" })).toBe("from-gh");
    expect(resolveGithubToken({ GITHUB_TOKEN: "from-github" })).toBe(
      "from-github",
    );
    expect(
      resolveGithubToken({ GH_TOKEN: "preferred", GITHUB_TOKEN: "fallback" }),
    ).toBe("preferred");
    expect(resolveGithubToken({})).toBeUndefined();
  });

  it("fails ensure-draft when no token is set in create or wait mode", () => {
    // Empty strings win over dotenv defaults (dotenv does not override).
    const env = {
      ...process.env,
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
    };

    for (const args of [[], ["--wait"]] as const) {
      const result = spawnSync(
        process.execPath,
        ["scripts/ensure-draft-release.cjs", ...args],
        { cwd: process.cwd(), encoding: "utf8", env },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toMatch(
        /GH_TOKEN or GITHUB_TOKEN is required/,
      );
    }
  });

  it("requires a release session before the draft script can contact GitHub", () => {
    const rejectedSessionCheck = () => {
      const error = Object.assign(new Error("release session missing"), {
        stderr: "release-session: FAILED: Release build session is missing.",
      });
      throw error;
    };
    expect(() =>
      verifyReleaseSession(rejectedSessionCheck as typeof spawnSync),
    ).toThrow("Release session verification failed");
  });

  it.each([
    ["gpg-sign", listAllGithubPages],
    ["ensure-draft-release", listAllGithubPagesCjs],
  ] as const)(
    "paginates GitHub list endpoints until a short or empty page (%s)",
    async (_label, paginate) => {
      const calls: Array<{ page: number; perPage: number }> = [];
      const pages = new Map<number, Array<{ id: number }>>([
        [1, Array.from({ length: 3 }, (_, index) => ({ id: index + 1 }))],
        [2, Array.from({ length: 3 }, (_, index) => ({ id: index + 4 }))],
        [3, [{ id: 7 }]],
      ]);

      const items = await paginate<{ id: number }>(
        async (page, perPage) => {
          calls.push({ page, perPage });
          return pages.get(page) ?? [];
        },
        { perPage: 3 },
      );

      expect(items.map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(calls).toEqual([
        { page: 1, perPage: 3 },
        { page: 2, perPage: 3 },
        { page: 3, perPage: 3 },
      ]);

      const emptyFirstPage = await paginate(async () => []);
      expect(emptyFirstPage).toEqual([]);

      const nonArray = await paginate(async () => ({ ok: false }));
      expect(nonArray).toEqual([]);
    },
  );

  it("syncs beta→latest manifests automatically during release:sign:gpg", () => {
    const source = fs.readFileSync("scripts/gpg-sign.js", "utf8");
    expect(source).toContain("if (IS_PRERELEASE)");
    expect(source).toContain(
      "await syncBetaManifestsToLatestStable(everything, release.id)",
    );
    // Must not gate the automatic path on draft/published; beta.23 briefly
    // skipped drafts and stranded clients until a manual sync ran.
    expect(source).not.toContain(
      "syncBetaManifests: skipped because the current release is still a draft.",
    );
    const syncBlock = source.slice(
      source.indexOf("for (const f of everything)"),
      source.indexOf("Done: ${TAG} uploaded as"),
    );
    expect(syncBlock).toContain("syncBetaManifestsToLatestStable");
    expect(syncBlock).not.toContain("if (!release.draft)");
  });

  it("keeps a recovery beta→latest sync entry point", () => {
    const source = fs.readFileSync("scripts/gpg-sign.js", "utf8");
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
    expect(source).toContain("--sync-beta-manifests");
    expect(source).toContain("syncBetaManifestsAfterPublish");
    expect(packageJson.scripts["release:sync-beta-manifests"]).toContain(
      "--sync-beta-manifests",
    );
  });

  it("stages live feed replacements before swapping asset names", () => {
    const source = fs.readFileSync("scripts/gpg-sign.js", "utf8");
    const uploadOnce = source.slice(
      source.indexOf("async function uploadAssetOnce"),
      source.indexOf("async function uploadAsset("),
    );
    // Regression: awaiting without return made beta→latest sync always fail
    // with "GitHub did not identify staged asset".
    expect(uploadOnce).toMatch(
      /return await new Promise\(\(resolve, reject\) => \{/,
    );
    expect(uploadOnce).toContain('typeof parsed.id !== "number"');

    const transaction = source.slice(
      source.indexOf("async function replaceReleaseAssetsTransactionally"),
      source.indexOf("async function uploadAssetWithReplace"),
    );
    // GitHub strips leading periods from asset names — do not use dotfiles.
    expect(transaction).toContain("zinnia-pending-");
    expect(transaction).toContain("zinnia-previous-");
    expect(transaction).not.toContain(".zinnia-pending-");
    expect(transaction).not.toContain(".zinnia-previous-");
    expect(transaction).toContain('"PATCH"');
    expect(
      transaction.indexOf("uploadAsset(release.upload_url, stagedPath)"),
    ).toBeLessThan(transaction.indexOf('"PATCH"'));
    expect(transaction.indexOf('"PATCH"')).toBeLessThan(
      transaction.indexOf('"DELETE"'),
    );
  });

  it("requires the complete core beta updater target set", () => {
    expect(requiredPublishedBetaManifestNames()).toEqual(
      expect.arrayContaining([
        "latest-windows-beta-x86_64-nsis.json",
        "latest-windows-beta-aarch64-nsis.json",
        "latest-darwin-beta-x86_64-app.json",
        "latest-darwin-beta-aarch64-app.json",
        "latest-linux-beta-x86_64-appimage.json",
        "latest-linux-beta-x86_64-deb.json",
        "latest-linux-beta-x86_64-rpm.json",
      ]),
    );
  });

  it("accepts a complete optional Linux ARM64 updater target group", () => {
    const arm64 = ["", "-appimage", "-deb", "-rpm"].map(
      (suffix) => `latest-linux-beta-aarch64${suffix}.json`,
    );
    expect(expectedPublishedBetaManifestNames(arm64)).toEqual(
      expect.arrayContaining(arm64),
    );
    expect(() =>
      expectedPublishedBetaManifestNames(arm64.slice(0, -1)),
    ).toThrow(/incomplete optional target group/);
  });

  it("rejects beta manifests that reference another release", () => {
    expect(() =>
      validatePublishedBetaManifest({
        name: "latest-linux-beta-x86_64.json",
        contents: JSON.stringify({
          version: "0.6.1-beta.1",
          platforms: {
            "linux-x86_64": {
              url: "https://github.com/BurntToasters/zinnia/releases/download/v0.6.1-beta.0/Zinnia.AppImage",
              signature: "signed",
            },
          },
        }),
        releaseAssetNames: new Set(["Zinnia.AppImage"]),
      }),
    ).toThrow(/outside the published/);
  });

  it("passes GH_TOKEN or GITHUB_TOKEN into updater-live GitHub authorization", () => {
    const source = fs.readFileSync("scripts/validate-updater-live.js", "utf8");
    expect(source).toContain(
      "process.env.GH_TOKEN || process.env.GITHUB_TOKEN",
    );
  });

  it("verifies Microsoft Authenticode before using Windows signing tools", () => {
    const tools = fs.readFileSync("scripts/artifact-signing-tools.ps1", "utf8");
    const setup = fs.readFileSync(
      "scripts/setup-windows-artifact-signing.ps1",
      "utf8",
    );
    expect(tools).toContain("Get-AuthenticodeSignature");
    expect(tools).toContain("O=Microsoft Corporation");
    expect(tools).toContain("Assert-MicrosoftSignedFile -Path $signToolPath");
    expect(tools).toContain("Assert-MicrosoftSignedFile -Path $dlibPath");
    expect(tools).toContain("Select-MicrosoftSignedArtifactTool");
    expect(tools).toContain(
      "Program Files (x86)\\Microsoft\\ArtifactSigningClientTools",
    );
    expect(setup).toContain("Assert-MicrosoftSignedFile -Path $msiPath");
  });

  it("requires the baked App Group string in the macOS host Mach-O", () => {
    const group = "ABCD123456.run.rosie.zinnia.findersync";
    const binary = Buffer.concat([
      Buffer.from("padding-"),
      Buffer.from(group, "utf8"),
      Buffer.from("-trailer"),
    ]);
    expect(binaryContainsUtf8String(binary, group)).toBe(true);
    expect(() =>
      assertBinaryContainsAppGroup(binary, group, "test host"),
    ).not.toThrow();
    expect(() =>
      assertBinaryContainsAppGroup(
        Buffer.from("no-group-here"),
        group,
        "test host",
      ),
    ).toThrow(/missing baked App Group/);
  });

  it("fails closed when lipo cannot thin a fat Mach-O for App Group checks", () => {
    const group = "ABCD123456.run.rosie.zinnia.findersync";
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "zinnia-fat-app-group-"),
    );
    try {
      const fatPath = path.join(temporaryDirectory, "fat-host");
      // Fat magic so a whole-file fallback would incorrectly pass when the
      // group string is present, but no valid slices for lipo to thin.
      const fat = Buffer.alloc(128, 0);
      fat.writeUInt32BE(0xcafebabe, 0);
      Buffer.from(group, "utf8").copy(fat, 32);
      fs.writeFileSync(fatPath, fat);
      expect(isFatMachO(fat)).toBe(true);
      expect(() =>
        assertUniversalBinaryContainsAppGroup(fatPath, group, "test host"),
      ).toThrow(/universal Mach-O but lipo could not thin/);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("sends GitHub authorization only to HTTPS github.com URLs", () => {
    expect(
      githubAuthorizationForUrl(
        "https://github.com/owner/repo/releases/latest",
        "secret",
      ),
    ).toBe("Bearer secret");
    expect(
      githubAuthorizationForUrl(
        "https://github.com.evil.test/release",
        "secret",
      ),
    ).toBeUndefined();
    expect(
      githubAuthorizationForUrl("https://example.test/release", "secret"),
    ).toBeUndefined();
    expect(
      githubAuthorizationForUrl("http://github.com/release", "secret"),
    ).toBeUndefined();
  });

  it("requires --all before updating 7-Zip checksums", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/prepare-7z.js", "--update-checksums"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain(
      "Checksum updates require --all",
    );
  });

  it("requires an explicitly trusted extractor for checksum updates", () => {
    const downloads = fs.mkdtempSync(
      path.join(os.tmpdir(), "zinnia-7z-downloads-"),
    );
    const provenance = JSON.parse(
      fs.readFileSync("assets/7z-provenance.json", "utf8"),
    ) as { version: string };
    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/prepare-7z.js",
          "--update-checksums",
          "--all",
          "--version",
          provenance.version,
          "--verify-downloads",
          downloads,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toContain(
        "requires --trusted-7z",
      );
    } finally {
      fs.rmSync(downloads, { recursive: true, force: true });
    }
  });

  it("uses system tar and only the trusted extractor for official archives", () => {
    expect(
      officialArchiveExtractionCommand({
        archivePath: "/downloads/7z.tar.xz",
        destination: "/tmp/extracted",
        trusted7zPath: "/trusted/7zz",
      }),
    ).toEqual({
      command: "tar",
      args: ["-xJf", "/downloads/7z.tar.xz", "-C", "/tmp/extracted"],
    });
    expect(
      officialArchiveExtractionCommand({
        archivePath: "/downloads/7z-extra.7z",
        destination: "/tmp/extracted",
        trusted7zPath: "/trusted/7zz",
      }),
    ).toEqual({
      command: "/trusted/7zz",
      args: ["x", "-y", "-o/tmp/extracted", "/downloads/7z-extra.7z"],
    });
    expect(() =>
      officialArchiveExtractionCommand({
        archivePath: "/downloads/7z-extra.7z",
        destination: "/tmp/extracted",
      }),
    ).toThrow(/trusted 7-Zip extractor is required/);
  });

  it("accepts only trusted extractor files outside candidate roots", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "zinnia-trusted-7z-"),
    );
    const assetsDirectory = path.join(temporaryRoot, "repo", "assets");
    const outputDirectory = path.join(
      temporaryRoot,
      "repo",
      "src-tauri",
      "binaries",
    );
    const trustedDirectory = path.join(temporaryRoot, "trusted");
    fs.mkdirSync(assetsDirectory, { recursive: true });
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.mkdirSync(trustedDirectory);
    const trusted = path.join(trustedDirectory, "7zz");
    const candidate = path.join(assetsDirectory, "7zz");
    fs.writeFileSync(trusted, "trusted");
    fs.writeFileSync(candidate, "candidate");

    try {
      expect(
        validateTrusted7zPath(trusted, {
          assetsDirectory,
          outputDirectory,
        }),
      ).toBe(fs.realpathSync(trusted));
      expect(() =>
        validateTrusted7zPath(undefined, {
          assetsDirectory,
          outputDirectory,
        }),
      ).toThrow(/requires --trusted-7z/);
      expect(() =>
        validateTrusted7zPath(path.join(temporaryRoot, "missing"), {
          assetsDirectory,
          outputDirectory,
        }),
      ).toThrow(/does not exist/);
      expect(() =>
        validateTrusted7zPath(trustedDirectory, {
          assetsDirectory,
          outputDirectory,
        }),
      ).toThrow(/is not a file/);
      expect(() =>
        validateTrusted7zPath(candidate, {
          assetsDirectory,
          outputDirectory,
        }),
      ).toThrow(/outside candidate assets/);

      const outputCandidate = path.join(outputDirectory, "7zz");
      fs.writeFileSync(outputCandidate, "candidate output");
      expect(() =>
        validateTrusted7zPath(outputCandidate, {
          assetsDirectory,
          outputDirectory,
        }),
      ).toThrow(/outside generated output/);

      const candidateSymlink = path.join(trustedDirectory, "candidate-link");
      fs.symlinkSync(candidate, candidateSymlink);
      expect(() =>
        validateTrusted7zPath(candidateSymlink, {
          assetsDirectory,
          outputDirectory,
        }),
      ).toThrow(/outside candidate assets/);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(!hardLinksSupported)(
    "rejects a trusted extractor hard-linked from nested candidate assets",
    () => {
      const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "zinnia-trusted-7z-hard-link-"),
      );
      const assetsDirectory = path.join(temporaryRoot, "repo", "assets");
      const outputDirectory = path.join(
        temporaryRoot,
        "repo",
        "src-tauri",
        "binaries",
      );
      const trusted = path.join(temporaryRoot, "trusted", "7zz");
      fs.mkdirSync(path.dirname(trusted), { recursive: true });
      fs.mkdirSync(path.join(assetsDirectory, "nested"), { recursive: true });
      fs.mkdirSync(outputDirectory, { recursive: true });
      fs.writeFileSync(trusted, "trusted");
      fs.linkSync(trusted, path.join(assetsDirectory, "nested", "7zz"));

      try {
        expect(() =>
          validateTrusted7zPath(trusted, {
            assetsDirectory,
            outputDirectory,
          }),
        ).toThrow(/same file as a candidate assets file/);
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hardLinksSupported)(
    "rejects a trusted extractor hard-linked from nested generated output",
    () => {
      const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "zinnia-trusted-7z-hard-link-"),
      );
      const assetsDirectory = path.join(temporaryRoot, "repo", "assets");
      const outputDirectory = path.join(
        temporaryRoot,
        "repo",
        "src-tauri",
        "binaries",
      );
      const trusted = path.join(temporaryRoot, "trusted", "7zz");
      fs.mkdirSync(path.dirname(trusted), { recursive: true });
      fs.mkdirSync(assetsDirectory, { recursive: true });
      fs.mkdirSync(path.join(outputDirectory, "nested"), { recursive: true });
      fs.writeFileSync(trusted, "trusted");
      fs.linkSync(trusted, path.join(outputDirectory, "nested", "7zz"));

      try {
        expect(() =>
          validateTrusted7zPath(trusted, {
            assetsDirectory,
            outputDirectory,
          }),
        ).toThrow(/same file as a generated output file/);
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  it("detects git-prune direct execution on supported Node 22 versions", () => {
    const scriptPath = path.resolve("scripts/git-prune-local-branches.js");
    expect(
      isGitPruneDirectExecution(pathToFileURL(scriptPath).href, scriptPath),
    ).toBe(true);
    expect(
      isGitPruneDirectExecution(
        pathToFileURL(scriptPath).href,
        "/tmp/other.js",
      ),
    ).toBe(false);
  });
});
