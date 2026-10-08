#!/usr/bin/env node
/**
 * End-to-end dry run of the Zinnia release publish path. Nothing is published
 * and no signing key of record is used.
 *
 * What runs for real:
 *   - the release scripts, as child processes, from a copy of scripts/ inside a
 *     throwaway git repository under os.tmpdir();
 *   - a throwaway GnuPG key generated per run, and a throwaway minisign key
 *     generated per run for the updater signatures.
 *
 * What is stood in for:
 *   - GitHub: an in-process fake REST server (fixtures/fake-github-server.mjs).
 *     Children reach it through a `gh` stand-in on PATH and a fetch preload that
 *     refuses every host except the fake.
 *   - cargo: the Rust updater verifier is replaced by a Node minisign verifier
 *     with the same argument contract, because cargo builds are out of scope.
 *
 * Usage:   node scripts/e2e-release-dry-run.mjs
 * Output:  coverage/release-dry-run/result.json (exit 1 when any check fails)
 * Debug:   KEEP_RELEASE_DRY_RUN=1 keeps the temporary repositories.
 *           RELEASE_DRY_RUN_ONLY=id1,id2 runs a subset of scenarios.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FakeGitHub } from "./e2e-release-fixtures/fake-github-server.mjs";
import {
  generateMinisignKey,
  minisignPublicKeyText,
  signBytes,
  tauriPubkeyFromText,
  tauriSignatureFileContent,
} from "./e2e-release-fixtures/minisign.mjs";
import {
  requiredDraftAssetNames,
  requiredDraftBetaManifestNames,
} from "./verify-release-draft.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.dirname(SCRIPTS_DIR);
const FIXTURES_DIR = path.join(SCRIPTS_DIR, "e2e-release-fixtures");
const TEMPLATE_DIR = path.join(FIXTURES_DIR, "template");
const OFFLINE_PRELOAD = path.join(FIXTURES_DIR, "offline-github-fetch.mjs");
const GH_SHIM = path.join(FIXTURES_DIR, "gh-shim.mjs");
const CARGO_SHIM = path.join(FIXTURES_DIR, "cargo-shim.mjs");
const RESULT_PATH = path.join(
  REPO_ROOT,
  "coverage",
  "release-dry-run",
  "result.json",
);

const VERSION = "0.6.3-beta.90";
const TAG = `v${VERSION}`;
const STABLE_VERSION = "0.6.2";
const STABLE_TAG = `v${STABLE_VERSION}`;
const REPO_PATH = "/repos/BurntToasters/zinnia";
const RELEASES_PATH = `${REPO_PATH}/releases`;
const STEP_TIMEOUT_MS = 240_000;
const OUTPUT_TAIL_CHARS = 4000;
const KEEP_WORK = process.env.KEEP_RELEASE_DRY_RUN === "1";

// Updater-eligible artifacts, named as Tauri emits them. gpg-sign renames them
// to the public asset names listed by requiredDraftAssetNames().
const UPDATER_SOURCES = [
  `Zinnia_${VERSION}_x64-setup.exe`,
  `Zinnia_${VERSION}_arm64-setup.exe`,
  `Zinnia_${VERSION}_universal.app.tar.gz`,
  `Zinnia_${VERSION}_amd64.AppImage`,
  `Zinnia_${VERSION}_amd64.deb`,
  `Zinnia-${VERSION}-1.x86_64.rpm`,
];
const DMG_SOURCE = `Zinnia_${VERSION}_universal.dmg`;
const PLAIN_SOURCES = [DMG_SOURCE, "Zinnia.zip", "Zinnia-Linux.flatpak"];
const DMG_PUBLIC_NAME = "Zinnia-macOS.dmg";
const EXE_PUBLIC_NAME = "Zinnia-Windows-x64.exe";
const APPIMAGE_PUBLIC_NAME = "Zinnia-Linux-x64.AppImage";
const LINUX_MANIFEST_NAME = "latest-linux-x86_64.json";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function tail(text) {
  return text.length > OUTPUT_TAIL_CHARS
    ? text.slice(-OUTPUT_TAIL_CHARS)
    : text;
}

function payload(name, variant = "v1") {
  return Buffer.from(
    `zinnia release dry run payload ${variant} for ${name}\n`,
    "utf8",
  );
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result;
}

function createGpgHome() {
  // Short, private GNUPGHOME: gpg-agent sockets must stay under the unix path limit.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zd-gpg-"));
  fs.chmodSync(home, 0o700);
  fs.writeFileSync(
    path.join(home, "gpg-agent.conf"),
    "allow-loopback-pinentry\n",
  );
  const passphrase = crypto.randomBytes(24).toString("hex");
  runChecked("gpg", [
    "--homedir",
    home,
    "--batch",
    "--pinentry-mode",
    "loopback",
    "--passphrase",
    passphrase,
    "--quick-gen-key",
    "Zinnia Release Dry Run <dry-run@example.invalid>",
    "ed25519",
    "sign",
    "never",
  ]);
  const listing = runChecked("gpg", [
    "--homedir",
    home,
    "--batch",
    "--with-colons",
    "--list-keys",
  ]).stdout;
  const fingerprintLine = listing
    .split("\n")
    .find((line) => line.startsWith("fpr:"));
  if (!fingerprintLine) throw new Error("throwaway gpg key was not created");
  return {
    home,
    passphrase,
    fingerprint: fingerprintLine.split(":")[9],
  };
}

function destroyGpgHome(gpg) {
  spawnSync("gpgconf", ["--homedir", gpg.home, "--kill", "gpg-agent"], {
    stdio: "ignore",
  });
  fs.rmSync(gpg.home, { recursive: true, force: true });
}

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function copyTemplateTree(source, destination, replacements) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyTemplateTree(from, to, replacements);
      continue;
    }
    let text = fs.readFileSync(from, "utf8");
    for (const [needle, value] of Object.entries(replacements)) {
      text = text.split(needle).join(value);
    }
    fs.writeFileSync(to, text);
  }
}

function liveAssets(server, release) {
  const assets = new Map();
  for (const id of release.assetIds) {
    const asset = server.assets.get(id);
    if (asset)
      assets.set(asset.name, { id: asset.id, sha256: sha256(asset.bytes) });
  }
  return assets;
}

class DryRunContext {
  constructor(id, gpg, key, pubkey) {
    this.id = id;
    this.gpg = gpg;
    this.key = key;
    this.pubkey = pubkey;
    this.server = new FakeGitHub();
    // Resolve symlinks (macOS /var -> /private/var): release scripts guard
    // direct execution by comparing argv[1] with import.meta.url, and that
    // comparison fails silently when the path traverses a symlink.
    this.work = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `zinnia-dry-run-${id}-`)),
    );
    this.root = path.join(this.work, "zinnia");
    this.originPath = path.join(this.work, "origin.git");
    this.binDir = path.join(this.work, "bin");
    this.cargoLogPath = path.join(this.work, "cargo-verifier.jsonl");
    this.steps = [];
    this.checks = [];
    this.shaA = null;
    this.shaB = null;
  }

  async start() {
    await this.server.start();
    fs.mkdirSync(this.binDir);
    writeExecutable(
      path.join(this.binDir, "gh"),
      `#!/bin/sh\nexec "${process.execPath}" "${GH_SHIM}" "$@"\n`,
    );
    writeExecutable(
      path.join(this.binDir, "cargo"),
      `#!/bin/sh\nexec "${process.execPath}" "${CARGO_SHIM}" "$@"\n`,
    );
  }

  async stop() {
    await this.server.stop();
    if (!KEEP_WORK) fs.rmSync(this.work, { recursive: true, force: true });
  }

  check(name, pass, detail = "") {
    this.checks.push({ name, pass: Boolean(pass), detail: String(detail) });
  }

  childEnv(extra = {}) {
    return {
      PATH: `${this.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? os.homedir(),
      TMPDIR: os.tmpdir(),
      NODE_OPTIONS: `--import=${pathToFileURL(OFFLINE_PRELOAD).href}`,
      FAKE_GITHUB_BASE_URL: this.server.baseUrl,
      FAKE_CARGO_LOG: this.cargoLogPath,
      GNUPGHOME: this.gpg.home,
      GPG_KEY_ID: this.gpg.fingerprint,
      GPG_PASSPHRASE: this.gpg.passphrase,
      ...extra,
    };
  }

  // Runs one release script as a child process with the dry-run environment.
  runScript(label, script, args = [], extraEnv = {}) {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [path.join(this.root, script), ...args],
        {
          cwd: this.root,
          env: this.childEnv(extraEnv),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout = tail(stdout + chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = tail(stderr + chunk);
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), STEP_TIMEOUT_MS);
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        const step = {
          label,
          script,
          args,
          exitCode,
          signal,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started),
          stdoutTail: stdout,
          stderrTail: stderr,
        };
        this.steps.push(step);
        resolve(step);
      });
    });
  }

  git(args, { allowFailure = false } = {}) {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=Zinnia Release Dry Run",
        "-c",
        "user.email=dry-run@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: this.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status !== 0 && !allowFailure) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result;
  }

  headSha() {
    return this.git(["rev-parse", "HEAD"]).stdout.trim();
  }

  // Creates the fixture repository: base commit, release commit, pushed to a
  // local bare origin, with a published latest-stable release seeded.
  createRepository({ changelog } = {}) {
    fs.mkdirSync(this.root, { recursive: true });
    fs.cpSync(SCRIPTS_DIR, path.join(this.root, "scripts"), {
      recursive: true,
      filter: (source) =>
        source !== SCRIPT_PATH &&
        source !== FIXTURES_DIR &&
        !source.startsWith(`${FIXTURES_DIR}${path.sep}`),
    });
    copyTemplateTree(TEMPLATE_DIR, this.root, {
      __VERSION__: VERSION,
      __UPDATER_PUBKEY__: this.pubkey,
    });
    if (changelog !== undefined) {
      fs.writeFileSync(path.join(this.root, "CHANGELOG.md"), changelog);
    }
    this.git(["init", "-q", "-b", "beta"]);
    this.git(["add", "-A"]);
    this.git(["commit", "-q", "-m", "fixture base"]);
    this.shaA = this.headSha();
    this.git(["commit", "-q", "--allow-empty", "-m", `release ${TAG}`]);
    this.shaB = this.headSha();
    runChecked("git", ["init", "-q", "--bare", "-b", "beta", this.originPath]);
    this.git(["remote", "add", "origin", this.originPath]);
    this.git(["push", "-q", "-u", "origin", "beta"]);
    this.server.seedRelease({
      tagName: STABLE_TAG,
      name: STABLE_VERSION,
      targetCommitish: this.shaA,
      body: "Latest stable seed for the beta manifest sync.",
    });
    this.server.seedTag(STABLE_TAG, this.shaA);
    // Orphan from an interrupted earlier swap: the beta sync must clean it up.
    const stable = this.server.findRelease((r) => r.tag_name === STABLE_TAG);
    this.server.seedAsset(
      stable.id,
      "zinnia-rollback-0123456789abcdef-latest-stale.json",
      Buffer.from("{}\n"),
    );
  }

  // Mirrors release:prepare: record the quality-gate proof, then write the
  // build session. Both use the real modules and commands.
  prepareReleaseSession() {
    const sessionModule = pathToFileURL(
      path.join(this.root, "scripts", "release-session.js"),
    ).href;
    const script = `
      const { recordSuccessfulQualityGate } = await import(${JSON.stringify(sessionModule)});
      const result = recordSuccessfulQualityGate(process.cwd());
      if (!result.recorded) {
        console.error(result.dirtyFiles ?? "quality gate not recorded");
        process.exit(1);
      }
    `;
    runChecked(process.execPath, ["--input-type=module", "-e", script], {
      cwd: this.root,
    });
    runChecked(
      process.execPath,
      [
        path.join(this.root, "scripts", "dist-tools.js"),
        "clean-release-artifacts",
      ],
      { cwd: this.root },
    );
  }

  // Writes build outputs the way a platform build would, after the session.
  writeArtifacts({ dmgVariant = "v1" } = {}) {
    const dist = path.join(this.root, "dist");
    fs.mkdirSync(dist, { recursive: true });
    for (const name of UPDATER_SOURCES) {
      fs.writeFileSync(path.join(dist, name), payload(name));
      fs.writeFileSync(
        path.join(dist, `${name}.sig`),
        tauriSignatureFileContent(
          signBytes(payload(name), this.key, `timestamp:0\tfile:${name}`),
        ),
      );
    }
    for (const name of PLAIN_SOURCES) {
      const variant = name === DMG_SOURCE ? dmgVariant : "v1";
      fs.writeFileSync(path.join(dist, name), payload(name, variant));
    }
  }

  draftRelease() {
    return this.server.findRelease((release) => release.tag_name === TAG);
  }

  // Scenario helpers that wrap the publish-path scripts.
  ensureDraft() {
    return this.runScript(
      "release:draft (ensure-draft-release.cjs)",
      "scripts/ensure-draft-release.cjs",
    );
  }

  signAndUpload() {
    return this.runScript(
      "release:sign:gpg (gpg-sign.js)",
      "scripts/gpg-sign.js",
    );
  }

  verifyPublished() {
    return this.runScript(
      "release:verify:published (validate-updater-live.js)",
      "scripts/validate-updater-live.js",
      ["--expected-version=current"],
    );
  }

  verifyDraft({ artifacts = true } = {}) {
    return this.runScript(
      "release:verify:draft (verify-release-draft.js)",
      "scripts/verify-release-draft.js",
      artifacts ? ["--verify-artifacts"] : [],
    );
  }

  publish() {
    return this.runScript(
      "release:publish (publish-release.cjs)",
      "scripts/publish-release.cjs",
    );
  }

  requestsSince(mark) {
    return this.server.requests.slice(mark);
  }

  mark() {
    return this.server.requests.length;
  }

  cargoVerifierCalls() {
    if (!fs.existsSync(this.cargoLogPath)) return [];
    return fs
      .readFileSync(this.cargoLogPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

function isWrite(request) {
  return (
    request.method === "POST" ||
    request.method === "PATCH" ||
    request.method === "DELETE"
  );
}

function assertNoUnhandledRoutes(ctx) {
  const unhandled = ctx.server.requests.filter((request) => request.unhandled);
  ctx.check(
    "fake GitHub received only endpoints it implements",
    unhandled.length === 0,
    unhandled.map((request) => `${request.method} ${request.path}`).join("; "),
  );
}

async function createStandardFixture(ctx) {
  ctx.createRepository();
  ctx.prepareReleaseSession();
  ctx.writeArtifacts();
}

// Shared happy-path prefix: create the draft, then upload and sign everything.
async function draftAndUpload(ctx) {
  const ensure = await ctx.ensureDraft();
  ctx.check(
    "ensure-draft-release exits 0",
    ensure.exitCode === 0,
    ensure.stderrTail,
  );
  const sign = await ctx.signAndUpload();
  ctx.check("gpg-sign exits 0", sign.exitCode === 0, sign.stderrTail);
  return { ensure, sign };
}

async function scenarioHappyPathBeta(ctx) {
  await createStandardFixture(ctx);
  const preflight = await ctx.runScript(
    "release:preflight (release-preflight.js)",
    "scripts/release-preflight.js",
  );
  ctx.check(
    "release-preflight accepts the pushed beta release commit",
    preflight.exitCode === 0,
    preflight.stderrTail,
  );

  await draftAndUpload(ctx);
  const changelogText = fs.readFileSync(
    path.join(ctx.root, "CHANGELOG.md"),
    "utf8",
  );
  const draftPost = ctx.server.requests.find(
    (request) =>
      request.method === "POST" &&
      request.path === RELEASES_PATH &&
      request.body?.draft === true,
  );
  ctx.check(
    "draft is created for the tag at the release commit with CHANGELOG notes",
    Boolean(draftPost) &&
      draftPost.body.tag_name === TAG &&
      draftPost.body.target_commitish === ctx.shaB &&
      draftPost.body.prerelease === true &&
      draftPost.body.body === changelogText,
    `body length=${draftPost?.body?.body?.length} expected=${changelogText.length}`,
  );

  const draft = ctx.draftRelease();
  const draftAssets = draft ? liveAssets(ctx.server, draft) : new Map();
  const required = requiredDraftAssetNames();
  const missing = required.filter((name) => !draftAssets.has(name));
  ctx.check(
    "draft holds every required installer, sidecar, checksum and manifest",
    missing.length === 0,
    `missing: ${missing.join(", ")}`,
  );
  const uploadedNames = ctx.server.requests
    .filter(
      (request) =>
        request.method === "POST" &&
        request.status === 201 &&
        request.releaseId === draft?.id &&
        request.assetName !== undefined,
    )
    .map((request) => request.assetName);
  const duplicateUploads = uploadedNames.filter(
    (name, index) => uploadedNames.indexOf(name) !== index,
  );
  const notUploaded = required.filter((name) => !uploadedNames.includes(name));
  ctx.check(
    "every required draft asset is uploaded exactly once on the first pass",
    duplicateUploads.length === 0 && notUploaded.length === 0,
    `duplicates=${duplicateUploads.join(",")} notUploaded=${notUploaded.join(",")}`,
  );
  const finalNames = [...draftAssets.keys()].sort();
  ctx.check(
    "the draft ends with exactly the uploaded assets (nothing staged or lost)",
    finalNames.join("\n") === [...new Set(uploadedNames)].sort().join("\n"),
    `uploaded=${uploadedNames.length} final=${finalNames.length}`,
  );
  const stableRelease = ctx.server.findRelease(
    (r) => r.tag_name === STABLE_TAG,
  );
  const stableAssets = stableRelease
    ? liveAssets(ctx.server, stableRelease)
    : new Map();
  const betaManifests = requiredDraftBetaManifestNames();
  ctx.check(
    "beta updater manifests are synced onto the latest stable release",
    betaManifests.every((name) => stableAssets.has(name)),
    `synced=${[...stableAssets.keys()].filter((n) => /-beta-/.test(n)).length}/${betaManifests.length}`,
  );
  ctx.check(
    "the beta-manifest sync lock is released",
    !stableAssets.has("zinnia-beta-manifest-sync-lock"),
  );
  ctx.check(
    "the sync removes orphaned transaction assets from the latest stable release",
    ![...stableAssets.keys()].some((name) =>
      /^(?:default\.)?zinnia-(?:pending|previous|rollback)-/.test(name),
    ),
    [...stableAssets.keys()].filter((n) => n.startsWith("zinnia-")).join(","),
  );

  const verify = await ctx.verifyDraft({ artifacts: true });
  ctx.check(
    "release:verify:draft --verify-artifacts exits 0",
    verify.exitCode === 0,
    verify.stderrTail,
  );
  const publish = await ctx.publish();
  ctx.check(
    "release:publish exits 0",
    publish.exitCode === 0,
    publish.stderrTail,
  );

  const patch = ctx.server.requests.find(
    (request) =>
      request.method === "PATCH" &&
      request.path === `${RELEASES_PATH}/${draft?.id}` &&
      request.body?.draft === false,
  );
  ctx.check(
    "publish flips the draft to published with the verified commit",
    Boolean(patch) &&
      patch.body.target_commitish === ctx.shaB &&
      patch.body.prerelease === true,
    JSON.stringify(patch?.body ?? null),
  );
  const published = ctx.server.findRelease((r) => r.tag_name === TAG);
  ctx.check(
    "the tag is created at the release commit and the release is published",
    Boolean(published) &&
      !published.draft &&
      ctx.server.tags.get(TAG) === ctx.shaB,
    `tag=${ctx.server.tags.get(TAG)} head=${ctx.shaB}`,
  );
  const live = await ctx.verifyPublished();
  ctx.check(
    "release:verify:published (validate-updater-live.js) exits 0",
    live.exitCode === 0,
    live.stderrTail || live.stdoutTail,
  );
  const liveFeedReads = ctx.server.requests.filter(
    (request) =>
      request.download &&
      request.status === 200 &&
      request.path.includes("/releases/latest/download/latest-"),
  );
  ctx.check(
    "the live beta feed is read from the latest stable release",
    liveFeedReads.length === requiredDraftBetaManifestNames().length,
    `feed reads=${liveFeedReads.length}`,
  );
  const feedArtifactNames = new Set();
  const stableForFeed = ctx.server.findRelease(
    (r) => r.tag_name === STABLE_TAG,
  );
  for (const name of requiredDraftBetaManifestNames()) {
    const asset = ctx.server.findAsset(stableForFeed.id, name);
    const manifest = JSON.parse(asset.bytes.toString("utf8"));
    for (const entry of Object.values(manifest.platforms)) {
      feedArtifactNames.add(
        decodeURIComponent(new URL(entry.url).pathname.split("/").pop()),
      );
    }
  }
  const downloadedArtifacts = new Set(
    ctx.server.requests
      .filter(
        (request) =>
          request.download &&
          request.status === 200 &&
          request.path.includes(`/releases/download/${TAG}/`),
      )
      .map((request) => request.assetName),
  );
  const missingDownloads = [...feedArtifactNames].filter(
    (name) => !downloadedArtifacts.has(name),
  );
  ctx.check(
    "every artifact the live beta feed references is downloaded from the tag",
    missingDownloads.length === 0 && feedArtifactNames.size > 0,
    `feed=${feedArtifactNames.size} missing=${missingDownloads.join(",")}`,
  );
  const calls = ctx.cargoVerifierCalls();
  ctx.check(
    "updater signatures verify on every pass (gpg-sign, verify, publish, live check)",
    calls.length >= 4 &&
      calls.every((call) => call.results.every((r) => r.ok)) &&
      calls.slice(0, 3).every((call) => call.pairs === UPDATER_SOURCES.length),
    `calls=${calls.length} pairs=${calls.map((c) => c.pairs).join(",")}`,
  );
}

async function scenarioTagAtAnotherCommit(ctx) {
  await createStandardFixture(ctx);
  ctx.server.seedTag(TAG, ctx.shaA);
  await draftAndUpload(ctx);
  const mark = ctx.mark();
  const verify = await ctx.verifyDraft({ artifacts: true });
  ctx.check(
    "draft verification passes before the tag check",
    verify.exitCode === 0,
    verify.stderrTail,
  );
  const publish = await ctx.publish();
  ctx.check(
    "release:publish refuses (exit 1)",
    publish.exitCode === 1,
    `exit=${publish.exitCode}`,
  );
  ctx.check(
    "publish reports the tag points at another commit",
    publish.stderrTail.includes("already points to") &&
      publish.stderrTail.includes(ctx.shaA),
    publish.stderrTail.slice(-300),
  );
  const publishing = ctx
    .requestsSince(mark)
    .filter(
      (request) => request.method === "PATCH" && request.body?.draft === false,
    );
  ctx.check("no PATCH flips the draft to published", publishing.length === 0);
  const draft = ctx.draftRelease();
  ctx.check(
    "the draft stays a draft and the tag still points at the old commit",
    Boolean(draft?.draft) && ctx.server.tags.get(TAG) === ctx.shaA,
    `tag=${ctx.server.tags.get(TAG)}`,
  );
}

async function scenarioUploadFailureKeepsOldAsset(ctx) {
  await createStandardFixture(ctx);
  await draftAndUpload(ctx);
  const draft = ctx.draftRelease();
  const before = liveAssets(ctx.server, draft);
  const oldDmgSha = before.get(DMG_PUBLIC_NAME)?.sha256;
  const oldDmgId = before.get(DMG_PUBLIC_NAME)?.id;

  // A changed installer forces a conflict and the replace-by-staging path.
  ctx.writeArtifacts({ dmgVariant: "v2" });
  const newDmgSha = sha256(payload(DMG_SOURCE, "v2"));
  ctx.server.addFault({
    method: "POST",
    pathIncludes: "/assets",
    nameStartsWith: "zinnia-pending-",
    status: 500,
  });
  const mark = ctx.mark();
  const failed = await ctx.signAndUpload();
  ctx.check(
    "gpg-sign refuses when the staged upload fails (exit 1)",
    failed.exitCode === 1,
    `exit=${failed.exitCode}`,
  );
  ctx.check(
    "the failure is reported as the upload error",
    failed.stderrTail.includes("500"),
    failed.stderrTail.slice(-300),
  );
  const window = ctx.requestsSince(mark);
  const liveMutations = window.filter(
    (request) => request.method === "PATCH" || request.method === "DELETE",
  );
  ctx.check(
    "no live asset is renamed or deleted before the replacement upload succeeds",
    liveMutations.length === 0,
    liveMutations.map((r) => `${r.method} ${r.path}`).join("; "),
  );
  ctx.check(
    "the replacement was attempted and failed on staging",
    window.some(
      (request) =>
        request.faulted &&
        String(request.query.name ?? "").startsWith("zinnia-pending-"),
    ),
  );
  const afterFailure = liveAssets(ctx.server, draft);
  ctx.check(
    "the old Zinnia-macOS.dmg survives with its original bytes",
    afterFailure.get(DMG_PUBLIC_NAME)?.sha256 === oldDmgSha &&
      oldDmgSha !== newDmgSha,
    `old=${oldDmgSha} now=${afterFailure.get(DMG_PUBLIC_NAME)?.sha256}`,
  );
  ctx.check(
    "no staging asset is left on the draft after the failure",
    ![...afterFailure.keys()].some((name) =>
      /^(?:default\.)?zinnia-(?:pending|previous|rollback)-/.test(name),
    ),
    [...afterFailure.keys()].filter((n) => n.startsWith("zinnia-")).join(","),
  );

  ctx.server.clearFaults();
  const retryMark = ctx.mark();
  const retry = await ctx.signAndUpload();
  ctx.check(
    "retry after the failed upload exits 0",
    retry.exitCode === 0,
    retry.stderrTail,
  );
  const afterRetry = liveAssets(ctx.server, draft);
  ctx.check(
    "retry replaces the installer with the new bytes exactly once",
    afterRetry.get(DMG_PUBLIC_NAME)?.sha256 === newDmgSha,
    `now=${afterRetry.get(DMG_PUBLIC_NAME)?.sha256} expected=${newDmgSha}`,
  );
  const retryWindow = ctx.requestsSince(retryMark);
  const indexOf = (predicate) => retryWindow.findIndex(predicate);
  const stagedAt = indexOf(
    (r) =>
      r.method === "POST" &&
      r.status === 201 &&
      String(r.query.name ?? "").startsWith("zinnia-pending-") &&
      String(r.query.name).endsWith(DMG_PUBLIC_NAME),
  );
  const backupAt = indexOf(
    (r) =>
      r.method === "PATCH" &&
      String(r.body?.name ?? "").startsWith("zinnia-previous-") &&
      String(r.body?.name).endsWith(DMG_PUBLIC_NAME),
  );
  const liveAt = indexOf(
    (r) => r.method === "PATCH" && r.body?.name === DMG_PUBLIC_NAME,
  );
  const cleanupAt = indexOf(
    (r) => r.method === "DELETE" && r.assetId === oldDmgId,
  );
  ctx.check(
    "retry orders staged upload, then rename of the old asset, then the live rename, then cleanup",
    stagedAt >= 0 &&
      stagedAt < backupAt &&
      backupAt < liveAt &&
      liveAt < cleanupAt,
    `staged=${stagedAt} backup=${backupAt} live=${liveAt} cleanup=${cleanupAt}`,
  );
  ctx.check(
    "retry leaves no staging assets behind",
    ![...afterRetry.keys()].some(
      (name) =>
        name.startsWith("zinnia-pending-") ||
        name.startsWith("zinnia-previous-"),
    ),
  );
  const verify = await ctx.verifyDraft({ artifacts: true });
  ctx.check(
    "draft verifies after the retry",
    verify.exitCode === 0,
    verify.stderrTail,
  );
  const publish = await ctx.publish();
  ctx.check(
    "release publishes after the retry",
    publish.exitCode === 0,
    publish.stderrTail,
  );
}

async function scenarioPublishedArtifactMissing(ctx) {
  await createStandardFixture(ctx);
  await draftAndUpload(ctx);
  const verify = await ctx.verifyDraft({ artifacts: true });
  ctx.check(
    "draft verifies before publishing",
    verify.exitCode === 0,
    verify.stderrTail,
  );
  const publish = await ctx.publish();
  ctx.check("release publishes", publish.exitCode === 0, publish.stderrTail);
  const published = ctx.server.findRelease((r) => r.tag_name === TAG);
  ctx.server.removeAsset(published.id, APPIMAGE_PUBLIC_NAME);
  const live = await ctx.verifyPublished();
  ctx.check(
    "release:verify:published refuses a feed whose artifact is gone (exit 1)",
    live.exitCode === 1,
    `exit=${live.exitCode}`,
  );
  ctx.check(
    "the live check reports the artifact download as HTTP 404",
    live.stderrTail.includes("HTTP 404") &&
      live.stderrTail.includes(APPIMAGE_PUBLIC_NAME),
    live.stderrTail.slice(-300),
  );
}

async function scenarioManifestReferencesMissingAsset(ctx) {
  await createStandardFixture(ctx);
  await draftAndUpload(ctx);
  const draft = ctx.draftRelease();
  const manifest = JSON.parse(
    ctx.server.assets
      .get(ctx.server.findAsset(draft.id, LINUX_MANIFEST_NAME).id)
      .bytes.toString("utf8"),
  );
  for (const entry of Object.values(manifest.platforms)) {
    entry.url = entry.url.replace(
      /[^/]+$/,
      "Zinnia-Linux-x64-Missing.AppImage",
    );
  }
  ctx.server.mutateAssetBytes(
    LINUX_MANIFEST_NAME,
    draft.id,
    Buffer.from(JSON.stringify(manifest, null, 2)),
  );
  ctx.check(
    "fixture manifest now points at an asset that is not on the draft",
    !liveAssets(ctx.server, draft).has("Zinnia-Linux-x64-Missing.AppImage"),
  );

  const verify = await ctx.verifyDraft({ artifacts: false });
  ctx.check(
    "release:verify:draft refuses (exit 1)",
    verify.exitCode === 1,
    `exit=${verify.exitCode}`,
  );
  ctx.check(
    "verification names the missing manifest reference",
    verify.stderrTail.includes("is not a draft asset"),
    verify.stderrTail.slice(-300),
  );
  const mark = ctx.mark();
  const publish = await ctx.publish();
  ctx.check(
    "release:publish refuses (exit 1)",
    publish.exitCode === 1,
    `exit=${publish.exitCode}`,
  );
  ctx.check(
    "no PATCH publishes the draft",
    ctx
      .requestsSince(mark)
      .every(
        (request) =>
          !(request.method === "PATCH" && request.body?.draft === false),
      ),
  );
}

async function scenarioDraftMissingRequiredAsset(ctx) {
  await createStandardFixture(ctx);
  await draftAndUpload(ctx);
  const draft = ctx.draftRelease();
  ctx.server.removeAsset(draft.id, APPIMAGE_PUBLIC_NAME);
  const verify = await ctx.verifyDraft({ artifacts: true });
  ctx.check(
    "release:verify:draft refuses a draft with a deleted AppImage (exit 1)",
    verify.exitCode === 1,
    `exit=${verify.exitCode}`,
  );
  ctx.check(
    "verification names the missing required asset",
    verify.stderrTail.includes("missing required assets") &&
      verify.stderrTail.includes(APPIMAGE_PUBLIC_NAME),
    verify.stderrTail.slice(-300),
  );
  const mark = ctx.mark();
  const publish = await ctx.publish();
  ctx.check(
    "release:publish refuses (exit 1)",
    publish.exitCode === 1,
    `exit=${publish.exitCode}`,
  );
  ctx.check(
    "no PATCH publishes the draft",
    ctx
      .requestsSince(mark)
      .every(
        (request) =>
          !(request.method === "PATCH" && request.body?.draft === false),
      ),
  );
}

async function scenarioSignatureAssetMismatch(ctx) {
  await createStandardFixture(ctx);
  await draftAndUpload(ctx);
  const draft = ctx.draftRelease();
  const otherKey = generateMinisignKey();
  const forged = tauriSignatureFileContent(
    signBytes(
      payload(UPDATER_SOURCES[0]),
      otherKey,
      `timestamp:0\tfile:${UPDATER_SOURCES[0]}`,
    ),
  );
  ctx.server.mutateAssetBytes(
    `${EXE_PUBLIC_NAME}.sig`,
    draft.id,
    Buffer.from(forged),
  );
  const verify = await ctx.verifyDraft({ artifacts: true });
  ctx.check(
    "release:verify:draft refuses a .sig that differs from its manifest (exit 1)",
    verify.exitCode === 1,
    `exit=${verify.exitCode}`,
  );
  ctx.check(
    "verification reports the .sig does not match the manifest signature",
    verify.stderrTail.includes(
      "does not match updater signature in its manifest",
    ),
    verify.stderrTail.slice(-300),
  );
  const mark = ctx.mark();
  const publish = await ctx.publish();
  ctx.check(
    "release:publish refuses (exit 1)",
    publish.exitCode === 1,
    `exit=${publish.exitCode}`,
  );
  ctx.check(
    "no PATCH publishes the draft",
    ctx
      .requestsSince(mark)
      .every(
        (request) =>
          !(request.method === "PATCH" && request.body?.draft === false),
      ),
  );
}

async function scenarioUpdaterArtifactTampered(ctx) {
  await createStandardFixture(ctx);
  await draftAndUpload(ctx);
  const draft = ctx.draftRelease();
  ctx.server.mutateAssetBytes(
    EXE_PUBLIC_NAME,
    draft.id,
    Buffer.from("tampered after signing\n"),
  );
  const verify = await ctx.verifyDraft({ artifacts: true });
  ctx.check(
    "release:verify:draft refuses a tampered installer (exit 1)",
    verify.exitCode === 1,
    `exit=${verify.exitCode}`,
  );
  const failing = ctx
    .cargoVerifierCalls()
    .flatMap((call) => call.results)
    .filter((r) => !r.ok);
  ctx.check(
    "the updater verifier rejects the tampered installer",
    failing.some((r) => r.artifact === EXE_PUBLIC_NAME),
    JSON.stringify(failing).slice(0, 300),
  );
  const mark = ctx.mark();
  const publish = await ctx.publish();
  ctx.check(
    "release:publish refuses (exit 1)",
    publish.exitCode === 1,
    `exit=${publish.exitCode}`,
  );
  ctx.check(
    "no PATCH publishes the draft",
    ctx
      .requestsSince(mark)
      .every(
        (request) =>
          !(request.method === "PATCH" && request.body?.draft === false),
      ),
  );
}

async function scenarioExistingDraftTargetsOtherCommit(ctx) {
  await createStandardFixture(ctx);
  ctx.server.seedRelease({
    tagName: TAG,
    name: VERSION,
    targetCommitish: ctx.shaA,
    draft: true,
    prerelease: true,
  });
  const mark = ctx.mark();
  const ensure = await ctx.ensureDraft();
  ctx.check(
    "ensure-draft-release refuses (exit 1)",
    ensure.exitCode === 1,
    `exit=${ensure.exitCode}`,
  );
  ctx.check(
    "ensure-draft-release names the mismatched target",
    ensure.stderrTail.includes("targets"),
    ensure.stderrTail.slice(-300),
  );
  ctx.check(
    "no release is created or edited",
    ctx.requestsSince(mark).every((request) => !isWrite(request)),
  );
  const signMark = ctx.mark();
  const sign = await ctx.signAndUpload();
  ctx.check(
    "gpg-sign refuses a draft that targets another commit (exit 1)",
    sign.exitCode === 1,
    `exit=${sign.exitCode}`,
  );
  ctx.check(
    "gpg-sign names the commit mismatch",
    sign.stderrTail.includes("not checked-out commit"),
    sign.stderrTail.slice(-300),
  );
  ctx.check(
    "gpg-sign uploads nothing to the mismatched draft",
    ctx
      .requestsSince(signMark)
      .every(
        (request) =>
          !(request.method === "POST" && request.path.endsWith("/assets")),
      ),
  );
}

async function scenarioDraftWithWrongTag(ctx) {
  await createStandardFixture(ctx);
  ctx.server.seedRelease({
    tagName: "v0.6.3-beta.89",
    name: VERSION,
    targetCommitish: ctx.shaB,
    draft: true,
    prerelease: true,
  });
  const mark = ctx.mark();
  const ensure = await ctx.ensureDraft();
  ctx.check(
    "ensure-draft-release refuses (exit 1)",
    ensure.exitCode === 1,
    `exit=${ensure.exitCode}`,
  );
  ctx.check(
    "ensure-draft-release reports the wrong tag_name",
    ensure.stderrTail.includes("wrong tag_name"),
    ensure.stderrTail.slice(-300),
  );
  ctx.check(
    "no release is created or edited",
    ctx.requestsSince(mark).every((request) => !isWrite(request)),
  );
  const sign = await ctx.signAndUpload();
  ctx.check(
    "gpg-sign refuses the misnamed draft (exit 1)",
    sign.exitCode === 1 && sign.stderrTail.includes("wrong tag_name"),
    sign.stderrTail.slice(-300),
  );
  const verify = await ctx.verifyDraft({ artifacts: false });
  ctx.check(
    "verify-release-draft refuses the misnamed draft (exit 1)",
    verify.exitCode === 1 && verify.stderrTail.includes("wrong tag_name"),
    verify.stderrTail.slice(-300),
  );
}

async function scenarioDuplicateDrafts(ctx) {
  await createStandardFixture(ctx);
  ctx.server.seedRelease({
    tagName: TAG,
    name: VERSION,
    targetCommitish: ctx.shaB,
    draft: true,
    prerelease: true,
  });
  ctx.server.seedRelease({
    tagName: TAG,
    name: VERSION,
    targetCommitish: ctx.shaB,
    draft: true,
    prerelease: true,
  });
  const mark = ctx.mark();
  const ensure = await ctx.ensureDraft();
  ctx.check(
    "ensure-draft-release refuses duplicate drafts (exit 1)",
    ensure.exitCode === 1,
    `exit=${ensure.exitCode}`,
  );
  ctx.check(
    "ensure-draft-release reports multiple drafts",
    ensure.stderrTail.includes("Multiple draft releases"),
    ensure.stderrTail.slice(-300),
  );
  ctx.check(
    "no release is created or edited",
    ctx.requestsSince(mark).every((request) => !isWrite(request)),
  );
  const signMark = ctx.mark();
  const sign = await ctx.signAndUpload();
  ctx.check(
    "gpg-sign refuses duplicate drafts before uploading (exit 1)",
    sign.exitCode === 1 &&
      sign.stderrTail.includes("Resolve duplicates before signing"),
    sign.stderrTail.slice(-300),
  );
  ctx.check(
    "gpg-sign uploads nothing while duplicates exist",
    ctx
      .requestsSince(signMark)
      .every(
        (request) =>
          !(request.method === "POST" && request.path.endsWith("/assets")),
      ),
  );
  const verify = await ctx.verifyDraft({ artifacts: false });
  ctx.check(
    "verify-release-draft refuses duplicate drafts (exit 1)",
    verify.exitCode === 1 &&
      verify.stderrTail.includes("Resolve duplicates before verifying"),
    verify.stderrTail.slice(-300),
  );
}

async function scenarioChangelogSectionMissing(ctx) {
  ctx.createRepository({
    changelog:
      "# Changelog\n\n## Changes in `v0.6.2:`\n\n- Only the previous release is documented.\n",
  });
  ctx.prepareReleaseSession();
  ctx.writeArtifacts();
  const mark = ctx.mark();
  const ensure = await ctx.ensureDraft();
  ctx.check(
    "ensure-draft-release refuses (exit 1)",
    ensure.exitCode === 1,
    `exit=${ensure.exitCode}`,
  );
  ctx.check(
    "ensure-draft-release names the missing CHANGELOG section",
    ensure.stderrTail.includes(`has no ## Changes in \`v${VERSION}:\` section`),
    ensure.stderrTail.slice(-300),
  );
  ctx.check(
    "no release is created",
    ctx.requestsSince(mark).every((request) => !isWrite(request)),
  );
}

async function scenarioPublishWithoutDraft(ctx) {
  await createStandardFixture(ctx);
  const mark = ctx.mark();
  const publish = await ctx.publish();
  ctx.check(
    "release:publish refuses with no draft (exit 1)",
    publish.exitCode === 1,
    `exit=${publish.exitCode}`,
  );
  ctx.check(
    "the refusal names the missing draft",
    publish.stderrTail.includes("No GitHub draft exists"),
    publish.stderrTail.slice(-300),
  );
  ctx.check(
    "nothing is written to GitHub",
    ctx.requestsSince(mark).every((request) => !isWrite(request)),
  );
  const signMark = ctx.mark();
  const sign = await ctx.signAndUpload();
  ctx.check(
    "gpg-sign refuses to create a release (exit 1)",
    sign.exitCode === 1,
    `exit=${sign.exitCode}`,
  );
  ctx.check(
    "gpg-sign points the operator at the draft script",
    sign.stderrTail.includes("No GitHub release exists") &&
      sign.stderrTail.includes("release:draft"),
    sign.stderrTail.slice(-300),
  );
  ctx.check(
    "gpg-sign sends no POST that would create a release",
    ctx
      .requestsSince(signMark)
      .every(
        (request) =>
          !(request.method === "POST" && request.path === RELEASES_PATH),
      ),
  );
}

async function scenarioDraftPrereleaseFlagCorrected(ctx) {
  await createStandardFixture(ctx);
  ctx.server.seedRelease({
    tagName: TAG,
    name: VERSION,
    targetCommitish: ctx.shaB,
    draft: true,
    prerelease: false,
  });
  const ensure = await ctx.ensureDraft();
  ctx.check(
    "ensure-draft-release reuses the draft and exits 0",
    ensure.exitCode === 0,
    ensure.stderrTail,
  );
  ctx.check(
    "the reused draft is corrected to prerelease for a beta",
    ensure.stdoutTail.includes("Correcting draft prerelease flag"),
    ensure.stdoutTail.slice(-300),
  );
  const patch = ctx.server.requests.find(
    (request) =>
      request.method === "PATCH" &&
      request.path.startsWith(`${RELEASES_PATH}/`) &&
      request.body?.prerelease === true,
  );
  ctx.check(
    "the draft is patched with prerelease=true and the release notes",
    Boolean(patch) &&
      patch.body.tag_name === TAG &&
      patch.body.body ===
        fs.readFileSync(path.join(ctx.root, "CHANGELOG.md"), "utf8"),
    JSON.stringify(patch?.body ?? null).slice(0, 200),
  );
  ctx.check(
    "the draft now reports prerelease=true",
    ctx.draftRelease()?.prerelease === true,
  );
}

async function scenarioNoReleaseSession(ctx) {
  await createStandardFixture(ctx);
  fs.rmSync(path.join(ctx.root, "release", ".build-session.json"), {
    force: true,
  });
  const ensure = await ctx.ensureDraft();
  ctx.check(
    "ensure-draft-release refuses without a build session (exit 1)",
    ensure.exitCode === 1,
    `exit=${ensure.exitCode}`,
  );
  ctx.check(
    "the refusal says to run release:prepare",
    ensure.stderrTail.includes("Release session verification failed") &&
      ensure.stderrTail.includes("release:prepare"),
    ensure.stderrTail.slice(-300),
  );
  ctx.check(
    "the refusal happens before any GitHub request",
    ctx.server.requests.length === 0,
    `requests=${ctx.server.requests.length}`,
  );
}

async function scenarioPreflightRefusesDirtyTree(ctx) {
  await createStandardFixture(ctx);
  fs.writeFileSync(path.join(ctx.root, "scratch-notes.txt"), "uncommitted\n");
  const preflight = await ctx.runScript(
    "release:preflight (release-preflight.js)",
    "scripts/release-preflight.js",
  );
  ctx.check(
    "release-preflight refuses an uncommitted file (exit 1)",
    preflight.exitCode === 1,
    `exit=${preflight.exitCode}`,
  );
  ctx.check(
    "the refusal says the tree is not clean",
    preflight.stderrTail.includes("Working tree is not clean"),
    preflight.stderrTail.slice(-300),
  );
}

const SCENARIOS = [
  {
    id: "happy-path-beta",
    title: "Happy path: draft, upload, verify, publish a beta",
    run: scenarioHappyPathBeta,
  },
  {
    id: "tag-at-another-commit",
    title: "Existing tag points at another commit: publish refuses",
    run: scenarioTagAtAnotherCommit,
  },
  {
    id: "upload-failure-keeps-old-asset",
    title: "Replacement upload fails: old asset survives, retry converges",
    run: scenarioUploadFailureKeepsOldAsset,
  },
  {
    id: "published-artifact-missing",
    title:
      "Published feed points at an artifact that was removed: live check refuses",
    run: scenarioPublishedArtifactMissing,
  },
  {
    id: "manifest-missing-asset",
    title: "Updater manifest references a missing asset: refuse",
    run: scenarioManifestReferencesMissingAsset,
  },
  {
    id: "draft-missing-required-asset",
    title: "Draft lost a required AppImage: refuse",
    run: scenarioDraftMissingRequiredAsset,
  },
  {
    id: "signature-asset-mismatch",
    title: "Updater .sig differs from manifest signature: refuse",
    run: scenarioSignatureAssetMismatch,
  },
  {
    id: "updater-artifact-tampered",
    title: "Installer bytes differ from their signature: refuse",
    run: scenarioUpdaterArtifactTampered,
  },
  {
    id: "draft-targets-other-commit",
    title: "Existing draft targets another commit: draft script refuses",
    run: scenarioExistingDraftTargetsOtherCommit,
  },
  {
    id: "draft-wrong-tag",
    title: "Existing draft has the wrong tag_name: draft script refuses",
    run: scenarioDraftWithWrongTag,
  },
  {
    id: "duplicate-drafts",
    title: "Duplicate drafts for one tag: draft script refuses",
    run: scenarioDuplicateDrafts,
  },
  {
    id: "changelog-section-missing",
    title: "CHANGELOG has no section for the version: draft script refuses",
    run: scenarioChangelogSectionMissing,
  },
  {
    id: "publish-without-draft",
    title: "Publish with no draft: refuse",
    run: scenarioPublishWithoutDraft,
  },
  {
    id: "draft-prerelease-flag-corrected",
    title: "Reused draft with a wrong prerelease flag is corrected",
    run: scenarioDraftPrereleaseFlagCorrected,
  },
  {
    id: "no-release-session",
    title: "No build session: draft script refuses before contacting GitHub",
    run: scenarioNoReleaseSession,
  },
  {
    id: "preflight-dirty-tree",
    title: "Preflight refuses an uncommitted file",
    run: scenarioPreflightRefusesDirtyTree,
  },
];

async function runScenario(definition, shared) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const ctx = new DryRunContext(
    definition.id,
    shared.gpg,
    shared.key,
    shared.pubkey,
  );
  let error = null;
  try {
    await ctx.start();
    await definition.run(ctx);
    assertNoUnhandledRoutes(ctx);
  } catch (caught) {
    error =
      caught instanceof Error
        ? (caught.stack ?? caught.message)
        : String(caught);
  }
  const checks = ctx.checks;
  const pass =
    error === null && checks.length > 0 && checks.every((check) => check.pass);
  const result = {
    id: definition.id,
    title: definition.title,
    pass,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    error,
    checks,
    steps: ctx.steps,
    setupEvents: ctx.server.setupEvents,
    requests: ctx.server.requests,
    finalState: ctx.server.snapshot(),
    cargoVerifierCalls: ctx.cargoVerifierCalls(),
  };
  await ctx.stop();
  const marker = pass ? "PASS" : "FAIL";
  console.log(
    `[${marker}] ${definition.id} (${checks.filter((c) => c.pass).length}/${checks.length} checks)`,
  );
  for (const check of checks.filter((c) => !c.pass)) {
    console.log(
      `       x ${check.name}${check.detail ? ` :: ${check.detail}` : ""}`,
    );
  }
  if (error) console.log(`       x scenario error :: ${error.split("\n")[0]}`);
  return result;
}

async function main() {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const gpg = createGpgHome();
  const key = generateMinisignKey();
  const shared = {
    gpg,
    key,
    pubkey: tauriPubkeyFromText(minisignPublicKeyText(key)),
  };
  const scenarios = [];
  try {
    const only = (process.env.RELEASE_DRY_RUN_ONLY ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    for (const definition of SCENARIOS) {
      if (only.length > 0 && !only.includes(definition.id)) continue;
      scenarios.push(await runScenario(definition, shared));
    }
  } finally {
    destroyGpgHome(gpg);
  }
  const passed = scenarios.filter((scenario) => scenario.pass).length;
  const failed = scenarios.length - passed;
  const report = {
    schema: "zinnia-release-dry-run/1",
    version: VERSION,
    tag: TAG,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    keys: {
      gpg: "throwaway ed25519 key generated per run",
      updater: "throwaway minisign (Ed25519) key generated per run",
    },
    stubs: {
      github:
        "in-process fake REST server (scripts/e2e-release-fixtures/fake-github-server.mjs)",
      cargo:
        "Node minisign verifier with the verify_updater_signatures argument contract",
      network: "every other host is refused by the fetch preload",
    },
    summary: {
      scenarios: scenarios.length,
      passed,
      failed,
      pass: failed === 0,
    },
    scenarios,
  };
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `release dry run: ${passed}/${scenarios.length} scenarios passed; artifact ${path.relative(REPO_ROOT, RESULT_PATH)}`,
  );
  if (failed > 0) process.exitCode = 1;
}

if (
  process.argv[1] &&
  // realpath: the guard must not silently skip when the path goes through a symlink.
  pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href ===
    import.meta.url
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exitCode = 1;
  });
}
