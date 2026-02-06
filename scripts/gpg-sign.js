#!/usr/bin/env node
/**
 * Release pipeline — collect build artifacts, upload to GitHub, GPG-sign,
 * then upload signatures + SHA-256 checksums.
 *
 * Required env (via .env or CI secrets):
 *   GH_TOKEN          GitHub PAT with `repo` scope (or GITHUB_TOKEN in Actions)
 *   GPG_KEY_ID        Key ID / fingerprint to sign with
 *   GPG_PASSPHRASE    Passphrase for non-interactive signing
 *
 * Optional:
 *   GH_REPO_OWNER     defaults to "BurntToasters"
 *   GH_REPO_NAME      defaults to "chrysanthemum"
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import https from "https";
import { fileURLToPath } from "url";

/* ── paths & config ──────────────────────────────────────── */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const releaseDir = path.join(root, "release");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

const VERSION = pkg.version;
const TAG = `v${VERSION}`;

const GPG_KEY_ID = process.env.GPG_KEY_ID;
const GPG_PASSPHRASE = process.env.GPG_PASSPHRASE;
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "chrysanthemum";

/* ── artifact matching ───────────────────────────────────── */

const ext = (e) => (n) => n.toLowerCase().endsWith(e);
const rx = (r) => (n) => r.test(n);
const exact = (f) => (n) => n === f;

/** Every file type we want in the release. */
const ARTIFACT_RULES = [
  // Installers & packages
  ext(".exe"), ext(".msi"), ext(".dmg"), ext(".deb"), ext(".rpm"), ext(".flatpak"),
  rx(/\.appimage$/i),
  // macOS zip (from zip-macos.js, inside bundle/macos/)
  rx(/\.zip$/i),
  // Tauri updater archives
  rx(/\.nsis\.zip$/i),
  rx(/\.app\.tar\.gz$/i),
  rx(/\.appimage\.tar\.gz$/i),
  // Tauri updater signatures (.sig next to updater archives)
  rx(/\.nsis\.zip\.sig$/i),
  rx(/\.app\.tar\.gz\.sig$/i),
  rx(/\.appimage\.tar\.gz\.sig$/i),
  // Updater manifest
  exact("latest.json"),
];

/** Subset of artifacts that should be GPG-signed (distributables only). */
const SIGN_RULES = [
  ext(".exe"), ext(".msi"), ext(".dmg"), ext(".deb"), ext(".rpm"), ext(".flatpak"),
  rx(/\.appimage$/i),
  rx(/\.zip$/i),
  rx(/\.nsis\.zip$/i),
  rx(/\.app\.tar\.gz$/i),
  rx(/\.appimage\.tar\.gz$/i),
];

const isArtifact = (name) => ARTIFACT_RULES.some((r) => r(name));
const isSignable = (name) => SIGN_RULES.some((r) => r(name));

const SEARCH_DIRS = [
  path.join(root, "src-tauri", "target"),
  path.join(root, "dist"),
];

/* ── filesystem helpers ──────────────────────────────────── */

function walk(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, results);
    } else if (entry.isFile() && isArtifact(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function collectArtifacts() {
  fs.mkdirSync(releaseDir, { recursive: true });

  // First try to find new artifacts from build output
  const found = SEARCH_DIRS.flatMap((d) => walk(d));
  if (found.length > 0) {
    const collected = [];
    for (const src of found) {
      const dest = path.join(releaseDir, path.basename(src));
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        console.log(`  + ${path.basename(src)}`);
      }
      collected.push(dest);
    }
    return collected;
  }

  // Fall back to artifacts already staged in release/ (e.g. from CI download step)
  const staged = fs.readdirSync(releaseDir)
    .filter((n) => isArtifact(n) && !n.endsWith(".asc") && n !== "SHA256SUMS.txt")
    .map((n) => path.join(releaseDir, n));

  if (staged.length === 0) {
    console.error("No build artifacts found in:", [...SEARCH_DIRS, releaseDir].join(", "));
    process.exit(1);
  }

  console.log(`  Found ${staged.length} pre-staged artifact(s) in release/`);
  return staged;
}

/* ── checksums ───────────────────────────────────────────── */

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function generateChecksums(files) {
  const entries = files
    .filter((f) => !f.endsWith(".asc") && !path.basename(f).startsWith("SHA256SUMS"))
    .map((f) => `${sha256(f)}  ${path.basename(f)}`);
  const out = path.join(releaseDir, "SHA256SUMS.txt");
  fs.writeFileSync(out, entries.join("\n") + "\n");
  console.log(`  + SHA256SUMS.txt (${entries.length} entries)`);
  return out;
}

/* ── GPG signing ─────────────────────────────────────────── */

function signFile(filePath) {
  const asc = `${filePath}.asc`;
  let cmd = "gpg --batch --yes --armor --detach-sign";
  if (GPG_KEY_ID) cmd += ` --local-user "${GPG_KEY_ID}"`;
  if (GPG_PASSPHRASE) cmd += ` --pinentry-mode loopback --passphrase "${GPG_PASSPHRASE}"`;
  cmd += ` --output "${asc}" "${filePath}"`;
  execSync(cmd, { stdio: "pipe" });
  return asc;
}

function signArtifacts(files) {
  const ascFiles = [];
  for (const f of files) {
    if (isSignable(path.basename(f))) {
      ascFiles.push(signFile(f));
      console.log(`  + ${path.basename(f)}.asc`);
    }
  }
  return ascFiles;
}

/* ── GitHub API ──────────────────────────────────────────── */

function ghRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.github.com",
      path: endpoint,
      method,
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        "User-Agent": "Chrysanthemum-Release",
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
    if (body) opts.headers["Content-Type"] = "application/json";

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`GitHub ${res.statusCode}: ${json.message || data}`));
          }
        } catch {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getOrCreateRelease() {
  // Check for an existing release (published or draft) with this tag
  try {
    return await ghRequest("GET", `/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${TAG}`);
  } catch {
    // Fall through — tag doesn't exist yet
  }

  // Search drafts (drafts have no tag until published)
  try {
    const releases = await ghRequest("GET", `/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=30`);
    const draft = releases.find((r) => r.draft && r.tag_name === TAG);
    if (draft) return draft;
  } catch {
    // Ignore
  }

  // Create a new draft release
  return await ghRequest("POST", `/repos/${REPO_OWNER}/${REPO_NAME}/releases`, {
    tag_name: TAG,
    name: `Chrysanthemum ${VERSION}`,
    draft: true,
    prerelease: VERSION.includes("beta") || VERSION.includes("alpha"),
  });
}

async function uploadAsset(uploadUrl, filePath) {
  const fileName = path.basename(filePath);
  const content = fs.readFileSync(filePath);
  const url = new URL(uploadUrl.replace("{?name,label}", ""));
  url.searchParams.set("name", fileName);

  const isText = /\.(asc|txt|json)$/i.test(fileName);

  await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          Authorization: `Bearer ${GH_TOKEN}`,
          "User-Agent": "Chrysanthemum-Release",
          Accept: "application/vnd.github.v3+json",
          "Content-Type": isText ? "text/plain" : "application/octet-stream",
          "Content-Length": content.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 300) {
            resolve(true);
          } else if (res.statusCode === 422) {
            // Asset with same name already exists — skip
            console.log(`  ~ ${fileName} (already uploaded)`);
            resolve(true);
          } else {
            reject(new Error(`Upload ${fileName} failed ${res.statusCode}: ${data}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(content);
    req.end();
  });
}

/* ── main ────────────────────────────────────────────────── */

async function main() {
  console.log(`\nChrysanthemum ${VERSION} — release pipeline\n`);

  // 1 — Verify GPG is available
  console.log("[1/5] Checking GPG...");
  try {
    execSync("gpg --version", { stdio: "pipe" });
  } catch {
    console.error("gpg not found. Install GnuPG and try again.");
    process.exit(1);
  }

  // 2 — Collect build artifacts into release/
  console.log("[2/5] Collecting artifacts...");
  const artifacts = collectArtifacts();

  // 3 — Generate SHA-256 checksums
  console.log("[3/5] Generating checksums...");
  const checksumFile = generateChecksums(artifacts);

  // 4 — GPG-sign distributable artifacts + checksums
  console.log("[4/5] Signing...");
  const ascFiles = signArtifacts(artifacts);
  ascFiles.push(signFile(checksumFile));
  console.log(`  + SHA256SUMS.txt.asc`);

  // 5 — Upload everything to GitHub release
  if (!GH_TOKEN) {
    console.log("\n[5/5] GH_TOKEN not set — skipping GitHub upload.");
    console.log(`Artifacts staged in: ${releaseDir}\n`);
    return;
  }

  console.log("[5/5] Uploading to GitHub...");
  const release = await getOrCreateRelease();
  console.log(`  Release: ${release.html_url || TAG}`);

  const everything = fs.readdirSync(releaseDir).map((n) => path.join(releaseDir, n));
  for (const f of everything) {
    await uploadAsset(release.upload_url, f);
    console.log(`  ^ ${path.basename(f)}`);
  }

  console.log(`\nDone — ${TAG} uploaded as ${release.draft ? "draft" : "published"}.\n`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
