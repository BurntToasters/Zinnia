import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  artifactMatchesVersion,
  assertReleaseTargetsCommit,
  buildUploadList,
  checksumTargetKeysForArtifactName,
  expectedPublishedBetaManifestNames,
  isExplicitTruthy,
  isTransactionalStagingAssetName,
  listAllGithubPages,
  requiredPublishedBetaManifestNames,
  rpmArtifactMatchesVersion,
  updaterChannelVariants,
  validatePublishedBetaManifest,
} from "../../scripts/gpg-sign.js";
import {
  assertDraftReleaseShape,
  requiredDraftAssetNames,
  selectDraftRelease,
} from "../../scripts/verify-release-draft.js";
import { validateChangelogForVersion } from "../../scripts/validate-changelog-version.js";
import {
  collectManifestArtifactRefs,
  shouldVerifyLiveArtifacts,
} from "../../scripts/validate-updater-live.js";
import { parseUpdate7zArgv } from "../../scripts/update-7z.js";
import { isDirectExecution as isGitPruneDirectExecution } from "../../scripts/git-prune-local-branches.js";
import {
  assertArchiveMemberNameSafe,
  assertExtractedTreeContained,
  findExtractedRegularFile,
  officialArchiveExtractionCommand,
  validateTrusted7zPath,
} from "../../scripts/prepare-7z-helpers.js";
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
  readChangelogReleaseBody,
  singleDraftRelease,
  verifyReleaseSession,
} = require("../../scripts/ensure-draft-release.cjs") as {
  assertReleaseTargetsCommit: (
    release: { target_commitish?: string },
    commit: string,
    env?: NodeJS.ProcessEnv,
    log?: { warn: (message: string) => void },
  ) => unknown;
  listAllGithubPages: typeof listAllGithubPages;
  readChangelogReleaseBody: (
    changelogPath?: string,
    version?: string,
  ) => string;
  singleDraftRelease: (
    matching: Array<{ draft?: boolean; tag_name?: string; id?: number }>,
  ) => { draft?: boolean; tag_name?: string; id?: number } | null;
  verifyReleaseSession: (run?: typeof spawnSync) => void;
};
const { assertStableReleaseOverridesAllowed, isStableReleaseVersion } =
  require("../../scripts/release-policy.cjs") as {
    assertStableReleaseOverridesAllowed: (
      env?: NodeJS.ProcessEnv,
      version?: string,
    ) => void;
    isStableReleaseVersion: (version: string | undefined | null) => boolean;
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
    // Empty env: a developer shell with FORCE_UPLOAD=1 must not bypass this.
    expect(() =>
      assertReleaseTargetsCommitCjs({ target_commitish: "main" }, commit, {}),
    ).toThrow("not checked-out commit");
    expect(
      assertReleaseTargetsCommitCjs({ target_commitish: commit }, commit, {}),
    ).toEqual({ target_commitish: commit });

    const gpgSource = fs.readFileSync("scripts/gpg-sign.js", "utf8");
    const draftSource = fs.readFileSync(
      "scripts/ensure-draft-release.cjs",
      "utf8",
    );
    expect(gpgSource).toContain("assertReleaseTargetsCommit");
    expect(gpgSource).toContain("FORCE_UPLOAD");
    expect(gpgSource).toContain("npm run release:draft");
    expect(gpgSource).not.toContain("target_commitish: commit,");
    expect(draftSource).toContain("FORCE_UPLOAD");
    expect(draftSource).toMatch(
      /if \(afterRetry\) \{\s*assertReleaseTargetsCommit\(afterRetry, commit\);/,
    );
  });

  it("allows FORCE_UPLOAD to bypass draft commit mismatch", () => {
    const commit = "b".repeat(40);
    const release = { target_commitish: "beta" };
    const warnings: string[] = [];
    const log = { warn: (message: string) => warnings.push(String(message)) };

    expect(
      assertReleaseTargetsCommit(release, commit, { FORCE_UPLOAD: "1" }, log),
    ).toEqual(release);
    expect(warnings.join("\n")).toContain("FORCE_UPLOAD=1");

    expect(
      assertReleaseTargetsCommitCjs(
        release,
        commit,
        { FORCE_UPLOAD: "true" },
        log,
      ),
    ).toEqual(release);

    expect(() => assertReleaseTargetsCommit(release, commit, {}, log)).toThrow(
      /FORCE_UPLOAD=1 to bypass/,
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

  it("reads only the current CHANGELOG.md version section for Windows draft notes", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      version: string;
    };
    const body = readChangelogReleaseBody();
    expect(body).toContain(`## Changes in \`v${pkg.version}:\``);
    expect(body.trim().length).toBeGreaterThan(0);
    expect(body).not.toContain("## Changes in `v0.6.1-beta.6:`");

    const mixed = path.join(
      os.tmpdir(),
      `zinnia-mixed-changelog-${Date.now()}.md`,
    );
    fs.writeFileSync(
      mixed,
      [
        "## Changes in `v9.9.9:`",
        "",
        "- **Fix:** current notes only.",
        "",
        "## Changes in `v0.1.0:`",
        "",
        "- **Fix:** historical notes must not ship.",
        "",
      ].join("\n"),
    );
    try {
      const extracted = readChangelogReleaseBody(mixed, "9.9.9");
      expect(extracted).toContain("current notes only");
      expect(extracted).not.toContain("historical notes must not ship");
    } finally {
      fs.rmSync(mixed, { force: true });
    }

    const missing = path.join(
      os.tmpdir(),
      `zinnia-missing-changelog-${Date.now()}.md`,
    );
    expect(() => readChangelogReleaseBody(missing)).toThrow(
      /CHANGELOG\.md is required/,
    );

    const empty = path.join(
      os.tmpdir(),
      `zinnia-empty-changelog-${Date.now()}.md`,
    );
    fs.writeFileSync(empty, "   \n");
    try {
      expect(() => readChangelogReleaseBody(empty)).toThrow(
        /CHANGELOG\.md is empty/,
      );
    } finally {
      fs.rmSync(empty, { force: true });
    }

    const source = fs.readFileSync("scripts/ensure-draft-release.cjs", "utf8");
    expect(source).toContain("readChangelogReleaseBody");
    expect(source).toContain("singleDraftRelease");
    expect(source).toContain("syncReleaseNotesBody");
    expect(source).toContain("body,");
    expect(source).toContain("PATCH");
    expect(source).not.toContain("or run it here once");
  });

  it("refuses duplicate drafts for the same tag", () => {
    expect(singleDraftRelease([])).toBeNull();
    expect(singleDraftRelease([{ draft: false }])).toBeNull();
    expect(singleDraftRelease([{ draft: true, id: 1 }])).toEqual({
      draft: true,
      id: 1,
    });
    expect(() =>
      singleDraftRelease([
        { draft: true, id: 1 },
        { draft: true, id: 2 },
      ]),
    ).toThrow(/Multiple draft releases/);
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

  it("auto-syncs beta manifests onto /releases/latest during each sign upload", () => {
    const source = fs.readFileSync("scripts/gpg-sign.js", "utf8");
    const syncBlock = source.slice(
      source.indexOf("for (const f of everything)"),
      source.indexOf("Done: ${TAG} uploaded as"),
    );
    expect(syncBlock).toContain("if (IS_PRERELEASE)");
    expect(syncBlock).toContain(
      "syncBetaManifestsToLatestStable(everything, release.id)",
    );
    expect(syncBlock).not.toContain("!release.draft");
  });

  it("refuses to create a GitHub release during signing", () => {
    const source = fs.readFileSync("scripts/gpg-sign.js", "utf8");
    const fn = source.slice(
      source.indexOf("async function getOrCreateRelease"),
      source.indexOf("async function uploadAssetOnce"),
    );
    expect(fn).toContain("npm run release:draft");
    expect(fn).not.toMatch(/"POST"/);
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
    expect(uploadOnce).toContain("typeof uploaded.id");
    expect(uploadOnce).toContain("return uploaded");

    const transaction = source.slice(
      source.indexOf("async function replaceReleaseAssetsTransactionally"),
      source.indexOf("async function uploadAssetWithReplace"),
    );
    // GitHub strips leading periods from asset names  -  do not use dotfiles.
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

  it("serializes beta feed swaps and recognizes orphan transaction assets", () => {
    const source = fs.readFileSync("scripts/gpg-sign.js", "utf8");
    expect(source).toContain("withBetaManifestSyncLock(latestStable");
    expect(source).not.toContain("BETA_SYNC_LOCK_STALE_MS");
    expect(source).toContain(
      "Never remove the lock while another signer is active.",
    );
    expect(source).toContain("assertOwnsBetaManifestSyncLock");
    expect(source).toContain("assertStillHeld");
    expect(source).toContain("Lost the beta-manifest synchronization lock");
    expect(source).toContain("cleanupTransactionalStagingAssets(latestStable)");
    expect(isTransactionalStagingAssetName("zinnia-pending-a-feed.json")).toBe(
      true,
    );
    expect(
      isTransactionalStagingAssetName("default.zinnia-rollback-a-feed.json"),
    ).toBe(true);
    expect(isTransactionalStagingAssetName("latest-windows-beta.json")).toBe(
      false,
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
    const { version } = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    );
    expect(() =>
      validatePublishedBetaManifest({
        name: "latest-linux-beta-x86_64.json",
        contents: JSON.stringify({
          version,
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

  it("checks public updater downloads without injecting GitHub tokens", () => {
    const source = fs.readFileSync("scripts/validate-updater-live.js", "utf8");
    expect(source).not.toContain("GH_TOKEN");
    expect(source).not.toContain("GITHUB_TOKEN");
    expect(source).not.toContain("headers.Authorization");
  });

  it("discovers Windows Artifact Signing tools like 0.6.0 (path presence, no client-tool Authenticode gate)", () => {
    const tools = fs.readFileSync("scripts/artifact-signing-tools.ps1", "utf8");
    const setup = fs.readFileSync(
      "scripts/setup-windows-artifact-signing.ps1",
      "utf8",
    );
    expect(tools).toContain("Get-ArtifactSigningTools");
    expect(tools).toContain("Azure.CodeSigning.Dlib.dll");
    expect(tools).toContain("MicrosoftArtifactSigningClientTools");
    expect(tools).toContain("Select-Object -First 1");
    expect(tools).not.toContain("Assert-MicrosoftSignedFile");
    expect(tools).not.toContain("Select-MicrosoftSignedArtifactTool");
    expect(setup).toContain("Get-ArtifactSigningTools");
    expect(setup).toContain("Microsoft.Azure.ArtifactSigningClientTools");
    expect(setup).not.toContain("Remove-UnsignedLegacyArtifactSigningTrees");
    expect(setup).not.toContain("1638");
    expect(setup).not.toContain("REINSTALL=ALL");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    expect(pkg.scripts["setup:win:artifact-signing"]).toContain(
      "setup-windows-artifact-signing.ps1",
    );
    expect(pkg.scripts["setup:win:artifact-signing:repair"]).toBeUndefined();
    expect(pkg.scripts["validate:no-em-dash"]).toContain(
      "validate-no-em-dash.js",
    );
    expect(tools.match(/[^\x00-\x7F]/g)).toBeNull();
    expect(setup.match(/[^\x00-\x7F]/g)).toBeNull();
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

  it("does not treat the in-tree 7-Zip sidecar as a trusted extractor for updates", () => {
    const source = fs.readFileSync("scripts/update-7z.js", "utf8");
    expect(source).toContain("No trusted 7-Zip extractor found");
    expect(source).not.toContain("bundledRelative");
    expect(source).not.toContain("bundledPath");
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

  it("unlocks the signing keychain without putting the password on argv", () => {
    const source = fs.readFileSync("scripts/mac-keychain-ssh.sh", "utf8");
    expect(source).toContain("security -i");
    expect(source).not.toMatch(
      /unlock-keychain -p "\$\{?KEYCHAIN_PASSWORD\}?"/,
    );
    expect(source).not.toMatch(
      /set-key-partition-list[^\n]*-k "\$\{?KEYCHAIN_PASSWORD\}?"/,
    );
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
    expect(
      officialArchiveExtractionCommand({
        archivePath: "/downloads/7z2602-x64.exe",
        destination: "/tmp/extracted",
        trusted7zPath: "/trusted/7zz",
      }),
    ).toEqual({
      command: "/trusted/7zz",
      args: ["x", "-y", "-o/tmp/extracted", "/downloads/7z2602-x64.exe"],
    });
    expect(() =>
      officialArchiveExtractionCommand({
        archivePath: "/downloads/7z-extra.7z",
        destination: "/tmp/extracted",
      }),
    ).toThrow(/trusted 7-Zip extractor is required/);
  });

  it("rejects archive members that would escape the extract destination", () => {
    expect(() =>
      assertArchiveMemberNameSafe("../secret", "/tmp/extracted"),
    ).toThrow(/escapes/);
    expect(() =>
      assertArchiveMemberNameSafe("/etc/passwd", "/tmp/extracted"),
    ).toThrow(/absolute/);
    expect(() =>
      assertArchiveMemberNameSafe("C:\\Windows\\system32", "/tmp/extracted"),
    ).toThrow(/absolute/);
    expect(() =>
      assertArchiveMemberNameSafe("bin/7zz", "/tmp/extracted"),
    ).not.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "refuses extracted symlinks when resolving 7-Zip members",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "zinnia-7z-member-"));
      try {
        fs.writeFileSync(path.join(root, "real"), "payload");
        fs.symlinkSync("real", path.join(root, "7zz"));
        expect(() => findExtractedRegularFile(root, "7zz")).toThrow(/symlink/);
        expect(() => assertExtractedTreeContained(root)).toThrow(/symlink/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("packages full Windows 7-Zip runtime and RAR integration", () => {
    const prepare = fs.readFileSync("scripts/prepare-7z.js", "utf8");
    const build = fs.readFileSync("src-tauri/build.rs", "utf8");
    const windows = JSON.parse(
      fs.readFileSync("src-tauri/tauri.windows.conf.json", "utf8"),
    );
    const provenance = JSON.parse(
      fs.readFileSync("assets/7z-provenance.json", "utf8"),
    );
    expect(prepare).toContain('source: "win/x64/7z.exe"');
    expect(prepare).toContain('source: "win/arm64/7z.exe"');
    expect(build).toContain('"win/x64/7z.dll"');
    expect(build).toContain('"win/arm64/7z.dll"');
    expect(windows.bundle.resources["binaries/7z.dll"]).toBe("7z.dll");
    expect(
      windows.bundle.fileAssociations.some((entry: { ext: string[] }) =>
        entry.ext.includes("rar"),
      ),
    ).toBe(true);
    expect(provenance.artifacts["win/x64/7z.exe"].source).toBe(
      "windows-x64-installer",
    );
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

  it("requires the full draft installer, sidecar, checksum, and manifest matrix", () => {
    const names = requiredDraftAssetNames();
    expect(names).toEqual(
      expect.arrayContaining([
        "Zinnia-Windows-x64.exe",
        "Zinnia-Windows-x64.exe.sig",
        "Zinnia-Windows-x64.exe.asc",
        "Zinnia-macOS.dmg",
        "Zinnia-macOS.dmg.asc",
        "Zinnia-Linux-x64.AppImage",
        "Zinnia-Linux-x64.AppImage.sig",
        "Zinnia-Linux-x64.flatpak",
        "Zinnia-Linux-x64.flatpak.asc",
        "SHA256SUMS-windows-x86_64.txt",
        "SHA256SUMS-windows-x86_64.txt.asc",
        "latest-windows-x86_64.json",
        "latest-linux-x86_64.json",
        ...requiredPublishedBetaManifestNames(),
      ]),
    );
    expect(names).not.toContain("Zinnia-macOS.dmg.sig");
    expect(names).not.toContain("Zinnia-Linux-x64.flatpak.sig");
    expect(names).not.toContain("latest-linux-x86_64-deb.json");
    expect(names).not.toContain("Zinnia-Linux-arm64.AppImage");
    expect(names).not.toContain("latest-linux-beta-aarch64.json");
    expect(requiredDraftAssetNames({ requireLinuxAarch64: true })).toEqual(
      expect.arrayContaining([
        "Zinnia-Linux-arm64.deb",
        "latest-linux-aarch64.json",
        "latest-linux-beta-aarch64-rpm.json",
        "SHA256SUMS-linux-aarch64.txt",
      ]),
    );
  });

  it("fails closed when a draft is missing required assets or metadata", () => {
    const version = "0.6.1-beta.6";
    const headCommit = "c".repeat(40);
    const release = {
      draft: true,
      prerelease: true,
      target_commitish: headCommit,
    };
    expect(() =>
      assertDraftReleaseShape({
        release: { ...release, draft: false },
        assetNames: requiredDraftAssetNames(),
        version,
        headCommit,
      }),
    ).toThrow(/must still be a draft/);
    expect(() =>
      assertDraftReleaseShape({
        release: { ...release, prerelease: false },
        assetNames: requiredDraftAssetNames(),
        version,
        headCommit,
      }),
    ).toThrow(/prerelease=/);
    expect(() =>
      assertDraftReleaseShape({
        release,
        assetNames: requiredDraftAssetNames(),
        version,
        headCommit: "d".repeat(40),
      }),
    ).toThrow(/not HEAD/);
    expect(() =>
      assertDraftReleaseShape({
        release,
        assetNames: requiredDraftAssetNames().filter(
          (name: string) => name !== "Zinnia-Windows-x64.exe",
        ),
        version,
        headCommit,
      }),
    ).toThrow(/Zinnia-Windows-x64\.exe/);
    expect(
      assertDraftReleaseShape({
        release,
        assetNames: requiredDraftAssetNames(),
        version,
        headCommit,
      }).tag,
    ).toBe("v0.6.1-beta.6");
  });

  it("selects unpublished drafts by tag and refuses published matches", () => {
    expect(
      selectDraftRelease(
        [
          { tag_name: "v0.6.0", draft: false },
          { tag_name: "v0.6.1-beta.6", draft: true },
        ],
        "v0.6.1-beta.6",
      )?.draft,
    ).toBe(true);
    expect(selectDraftRelease([], "v0.6.1-beta.6")).toBeNull();
    expect(() =>
      selectDraftRelease([{ tag_name: "v0.6.1", draft: false }], "v0.6.1"),
    ).toThrow(/already published/);
  });

  it("refuses stable-only release overrides", () => {
    expect(isStableReleaseVersion("0.6.1")).toBe(true);
    expect(isStableReleaseVersion("0.6.1-beta.6")).toBe(false);
    expect(() =>
      assertStableReleaseOverridesAllowed({ SKIP_WIN_CODESIGN: "1" }, "0.6.1"),
    ).toThrow(/SKIP_WIN_CODESIGN/);
    expect(() =>
      assertStableReleaseOverridesAllowed({ FORCE_UPLOAD: "true" }, "0.6.1"),
    ).toThrow(/FORCE_UPLOAD/);
    expect(() =>
      assertStableReleaseOverridesAllowed(
        { SKIP_RELEASE_MIRROR: "1", ALLOW_ASSET_REPLACE: "1" },
        "0.6.1",
      ),
    ).toThrow(/SKIP_RELEASE_MIRROR/);
    expect(() =>
      assertStableReleaseOverridesAllowed({ SKIP_E2E: "1" }, "0.6.1"),
    ).toThrow(/SKIP_E2E/);
    expect(() =>
      assertStableReleaseOverridesAllowed(
        { SKIP_WIN_CONTEXT_MENU: "1" },
        "0.6.1",
      ),
    ).toThrow(/SKIP_WIN_CONTEXT_MENU/);
    expect(() =>
      assertStableReleaseOverridesAllowed(
        { SKIP_CARGO_INTEGRATION: "1" },
        "0.6.1",
      ),
    ).toThrow(/SKIP_CARGO_INTEGRATION/);
    expect(() =>
      assertStableReleaseOverridesAllowed(
        { FORCE_UPLOAD: "1", SKIP_WIN_CODESIGN: "1" },
        "0.6.1-beta.6",
      ),
    ).not.toThrow();
  });

  it("rejects Beta banners, placeholders, and prerelease URLs on stable CHANGELOG", () => {
    const betaOk = [
      "> 🅱️ This is a Beta build.\n",
      "# ⬇️ Downloads\n",
      "/download/v0.6.1-beta.6/Zinnia-Windows-x64.exe\n",
      "## Changes in `v0.6.1-beta.6:`\n",
      "- **Fix:** notes\n",
    ].join("");
    expect(validateChangelogForVersion(betaOk, "0.6.1-beta.6")).toEqual([]);

    const stableBad = [
      "> 🅱️ This is a Beta build.\n",
      "# ⬇️ Downloads\n",
      "/download/v0.6.1-beta.6/Zinnia-Windows-x64.exe\n",
      "## Changes in `v0.6.1:`\n",
      "- **Fix:** (add release notes)\n",
    ].join("");
    expect(validateChangelogForVersion(stableBad, "0.6.1")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Beta callout/),
        expect.stringMatching(/placeholder notes/),
        expect.stringMatching(/prerelease download URLs/),
      ]),
    );

    const stableOk = [
      "# ⬇️ Downloads\n",
      "/download/v0.6.1/Zinnia-Windows-x64.exe\n",
      "## Changes in `v0.6.1:`\n",
      "- **Fix:** notes\n",
    ].join("");
    expect(validateChangelogForVersion(stableOk, "0.6.1")).toEqual([]);
  });

  it("downloads live updater artifacts only for --expected-version=current", () => {
    expect(
      shouldVerifyLiveArtifacts({
        shapeOnly: true,
        requestedExpectedVersion: "current",
      }),
    ).toBe(false);
    expect(
      shouldVerifyLiveArtifacts({
        shapeOnly: false,
        requestedExpectedVersion: "0.6.0",
      }),
    ).toBe(false);
    expect(
      shouldVerifyLiveArtifacts({
        shapeOnly: false,
        requestedExpectedVersion: "current",
      }),
    ).toBe(true);
    const refs = collectManifestArtifactRefs([
      JSON.stringify({
        version: "0.6.1-beta.6",
        platforms: {
          "windows-x86_64": {
            url: "https://github.com/BurntToasters/zinnia/releases/download/v0.6.1-beta.6/Zinnia-Windows-x64.exe",
            signature: "sig",
          },
        },
      }),
    ]);
    expect(refs.get("Zinnia-Windows-x64.exe")).toEqual({
      url: "https://github.com/BurntToasters/zinnia/releases/download/v0.6.1-beta.6/Zinnia-Windows-x64.exe",
      signature: "sig",
    });
  });

  it("requires an explicit 7z:update action and treats --help as non-mutating", () => {
    expect(parseUpdate7zArgv(["--help"]).help).toBe(true);
    expect(parseUpdate7zArgv(["--update", "--help"]).help).toBe(true);
    expect(parseUpdate7zArgv(["--check"]).check).toBe(true);
    expect(() => parseUpdate7zArgv([])).toThrow(/requires --check/);
    expect(() => parseUpdate7zArgv(["--help-me"])).toThrow(/Unknown/);
    expect(() => parseUpdate7zArgv(["--check", "--update"])).toThrow(
      /cannot be combined/,
    );
    const help = spawnSync(
      process.execPath,
      ["scripts/update-7z.js", "--update", "--help"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(help.status).toBe(0);
    expect(`${help.stdout}${help.stderr}`).toMatch(/Usage:/);
    expect(`${help.stdout}${help.stderr}`).not.toMatch(/Downloading/);
  });

  it("keeps VM reset scripts as inline destructive git for release hosts", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.b).toContain("git switch -C beta origin/beta");
    expect(packageJson.scripts.b).toContain("git reset --hard");
    expect(packageJson.scripts.r).toContain("git switch -C main origin/main");
    expect(packageJson.scripts.r).toContain("gitprune:force");
    expect(packageJson.scripts["release:verify:draft"]).toContain(
      "verify-release-draft.js",
    );
  });
});
