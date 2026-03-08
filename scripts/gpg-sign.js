#!/usr/bin/env node


import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync, spawnSync } from "child_process";
import https from "https";
import { fileURLToPath } from "url";



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
const REPO_NAME = process.env.GH_REPO_NAME || "zinnia";



const ext = (e) => (n) => n.toLowerCase().endsWith(e);
const rx = (r) => (n) => r.test(n);
const exact = (f) => (n) => n === f;


const ARTIFACT_RULES = [

  rx(/-setup\.exe$/i), ext(".msi"), ext(".dmg"), ext(".deb"), ext(".rpm"), ext(".flatpak"),
  rx(/\.appimage$/i),
  
  rx(/\.zip$/i),
  
  rx(/\.nsis\.zip$/i),
  rx(/\.app\.tar\.gz$/i),
  rx(/\.appimage\.tar\.gz$/i),
  
  rx(/\.nsis\.zip\.sig$/i),
  rx(/\.app\.tar\.gz\.sig$/i),
  rx(/\.appimage\.tar\.gz\.sig$/i),
  
  exact("latest.json"),
];


const SIGN_RULES = [
  rx(/-setup\.exe$/i), ext(".msi"), ext(".dmg"), ext(".deb"), ext(".rpm"), ext(".flatpak"),
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

function artifactMatchesVersion(name) {
  if (name === "latest.json") return true;
  const versions = name.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/g);
  if (!versions || versions.length === 0) return true;
  return versions.includes(VERSION);
}

function clearReleaseStaging() {
  if (!fs.existsSync(releaseDir)) return;
  for (const name of fs.readdirSync(releaseDir)) {
    const fullPath = path.join(releaseDir, name);
    let isFile = false;
    try {
      isFile = fs.statSync(fullPath).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    if (isArtifact(name) || name.endsWith(".asc") || name === "SHA256SUMS.txt") {
      fs.rmSync(fullPath, { force: true });
    }
  }
}

function pickNewestByBasename(paths) {
  const latest = new Map();
  for (const filePath of paths) {
    const name = path.basename(filePath);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    const current = latest.get(name);
    if (!current || stat.mtimeMs > current.mtimeMs) {
      latest.set(name, { filePath, mtimeMs: stat.mtimeMs });
    }
  }
  return Array.from(latest.values()).map((entry) => entry.filePath);
}



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

function cleanArtifactName(name) {
  if (name === "latest.json") return name;
  if (/\.tar\.gz(\.sig)?$/i.test(name)) return name;
  if (/\.nsis\.zip(\.sig)?$/i.test(name)) return name;

  if (/\.dmg$/i.test(name)) return "Zinnia-macOS.dmg";
  if (/^Zinnia\.zip$/i.test(name)) return "Zinnia-macOS.zip";

  if (/x64-setup\.exe$/i.test(name)) return "Zinnia-Windows-x64.exe";
  if (/arm64-setup\.exe$/i.test(name)) return "Zinnia-Windows-arm64.exe";

  if (/amd64\.AppImage$/i.test(name)) return "Zinnia-Linux-x64.AppImage";
  if (/aarch64\.AppImage$/i.test(name)) return "Zinnia-Linux-arm64.AppImage";

  if (/amd64\.deb$/i.test(name)) return "Zinnia-Linux-x64.deb";
  if (/aarch64\.deb$/i.test(name)) return "Zinnia-Linux-arm64.deb";

  if (/x86_64\.rpm$/i.test(name)) return "Zinnia-Linux-x64.rpm";
  if (/aarch64\.rpm$/i.test(name)) return "Zinnia-Linux-arm64.rpm";

  if (/\.flatpak$/i.test(name)) return name;

  return name;
}

function collectArtifacts() {
  fs.mkdirSync(releaseDir, { recursive: true });

  
  const discovered = SEARCH_DIRS.flatMap((d) => walk(d));
  const found = discovered.filter((filePath) => artifactMatchesVersion(path.basename(filePath)));
  if (found.length > 0) {
    clearReleaseStaging();
    if (found.length < discovered.length) {
      console.log(`  ~ Skipped ${discovered.length - found.length} artifact(s) not matching ${VERSION}`);
    }

    const selected = pickNewestByBasename(found);
    const collected = [];
    for (const src of selected) {
      const originalName = path.basename(src);
      const cleanName = cleanArtifactName(originalName);
      const dest = path.join(releaseDir, cleanName);
      fs.copyFileSync(src, dest);
      if (cleanName !== originalName) {
        console.log(`  + ${originalName} → ${cleanName}`);
      } else {
        console.log(`  + ${originalName}`);
      }
      collected.push(dest);
    }
    return collected;
  }

  
  const staged = fs.readdirSync(releaseDir)
    .filter((n) => isArtifact(n) && artifactMatchesVersion(n) && !n.endsWith(".asc") && n !== "SHA256SUMS.txt")
    .map((n) => path.join(releaseDir, n));

  if (staged.length === 0) {
    console.error("No build artifacts found in:", [...SEARCH_DIRS, releaseDir].join(", "));
    process.exit(1);
  }

  console.log(`  Found ${staged.length} pre-staged artifact(s) in release/`);
  return staged;
}



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



function signFile(filePath) {
  const asc = `${filePath}.asc`;
  const args = ["--batch", "--yes", "--armor", "--detach-sign"];
  if (GPG_KEY_ID) {
    args.push("--local-user", GPG_KEY_ID);
  }
  if (GPG_PASSPHRASE) {
    args.push("--pinentry-mode", "loopback", "--passphrase", GPG_PASSPHRASE);
  }
  args.push("--output", asc, filePath);

  const result = spawnSync("gpg", args, { stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`GPG signing failed: ${result.stderr?.toString() || "unknown error"}`);
  }
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



function ghRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.github.com",
      path: endpoint,
      method,
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        "User-Agent": "Zinnia-Release",
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
  
  try {
    return await ghRequest("GET", `/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${TAG}`);
  } catch {
    
  }

  
  try {
    const releases = await ghRequest("GET", `/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=30`);
    const draft = releases.find((r) => r.draft && r.tag_name === TAG);
    if (draft) return draft;
  } catch {
    
  }

  
  return await ghRequest("POST", `/repos/${REPO_OWNER}/${REPO_NAME}/releases`, {
    tag_name: TAG,
    name: `Zinnia ${VERSION}`,
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
          "User-Agent": "Zinnia-Release",
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



async function main() {
  console.log(`\nZinnia ${VERSION} — release pipeline\n`);

  
  console.log("[1/5] Checking GPG...");
  try {
    execSync("gpg --version", { stdio: "pipe" });
  } catch {
    console.error("gpg not found. Install GnuPG and try again.");
    process.exit(1);
  }

  
  console.log("[2/5] Collecting artifacts...");
  const artifacts = collectArtifacts();

  
  console.log("[3/5] Generating checksums...");
  const checksumFile = generateChecksums(artifacts);

  
  console.log("[4/5] Signing...");
  const ascFiles = signArtifacts(artifacts);
  ascFiles.push(signFile(checksumFile));
  console.log(`  + SHA256SUMS.txt.asc`);

  
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
