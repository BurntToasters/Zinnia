import fs from "fs";
import crypto from "crypto";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import {
  assertExtractedTreeContained,
  assertOfficialArchiveMembersSafe,
  officialArchiveExtractionCommand,
  validateTrusted7zPath,
} from "./prepare-7z-helpers.js";

const root = process.cwd();
const assetsDir = path.join(root, "assets");
const outDir = path.join(root, "src-tauri", "binaries");
const checksumPath = path.join(assetsDir, "7z-checksums.json");
const provenancePath = path.join(assetsDir, "7z-provenance.json");
const updateChecksums = process.argv.includes("--update-checksums");
const verifyDownloadsDir = optionValue("--verify-downloads");
const suppliedTrusted7z = optionValue("--trusted-7z");

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function loadChecksums() {
  if (!fs.existsSync(checksumPath)) {
    console.error(
      "FATAL: 7z-checksums.json not found. Cannot verify sidecar integrity.",
    );
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(checksumPath, "utf8"));
  } catch (err) {
    console.error(`FATAL: Could not parse 7z-checksums.json: ${err.message}`);
    process.exit(1);
  }
}

const mappings = [
  { source: "win/x64/7z.exe", target: "7z-x86_64-pc-windows-msvc.exe" },
  { source: "win/arm64/7z.exe", target: "7z-aarch64-pc-windows-msvc.exe" },
  { source: "mac/7zz", target: "7z-x86_64-apple-darwin" },
  { source: "mac/7zz", target: "7z-aarch64-apple-darwin" },
  { source: "mac/7zz", target: "7z-universal-apple-darwin" },
  { source: "linux/x64/7zzs", target: "7z-x86_64-unknown-linux-gnu" },
  { source: "linux/arm64/7zzs", target: "7z-aarch64-unknown-linux-gnu" },
];

// Windows full-runtime DLLs are copied by the Rust build script, so verify them
// here even though they are not standalone sidecars.
const checksumOnlySources = ["win/arm64/7z.dll", "win/x64/7z.dll"];

const requireAll =
  process.argv.includes("--all") || process.env.ZINNIA_REQUIRE_ALL_7Z === "1";

if (updateChecksums && !process.argv.includes("--all")) {
  throw new Error(
    "Checksum updates require --all so the complete 7-Zip checksum manifest is regenerated.",
  );
}

function requiredSourcesForHost() {
  if (requireAll) {
    return [...new Set(mappings.map((m) => m.source))];
  }
  if (process.platform === "win32") {
    return process.arch === "arm64"
      ? ["win/arm64/7z.exe", "win/arm64/7z.dll"]
      : ["win/x64/7z.exe", "win/x64/7z.dll"];
  }
  if (process.platform === "darwin") {
    return ["mac/7zz"];
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? ["linux/arm64/7zzs"] : ["linux/x64/7zzs"];
  }
  return [];
}

function runTool(command, args) {
  const result = spawnSync(command, args, { stdio: "pipe" });
  if (result.error) {
    return { ok: false, message: String(result.error.message || result.error) };
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    const stdout = result.stdout?.toString().trim();
    return {
      ok: false,
      message:
        stderr || stdout || `${command} exited with code ${result.status}`,
    };
  }
  return { ok: true, message: "" };
}

function sanitizeMacSidecar(targetPath) {
  const xattr = runTool("xattr", ["-cr", targetPath]);
  if (!xattr.ok) {
    const ignorable = /No such xattr|No such file|not found/i.test(
      xattr.message,
    );
    if (!ignorable) {
      console.warn(
        `xattr cleanup failed for ${path.basename(targetPath)}: ${xattr.message}`,
      );
    }
  }

  const removeSig = runTool("codesign", ["--remove-signature", targetPath]);
  if (!removeSig.ok) {
    const ignorable = /is not signed at all|code object is not signed/i.test(
      removeSig.message,
    );
    if (!ignorable) {
      console.warn(
        `codesign signature cleanup failed for ${path.basename(targetPath)}: ${removeSig.message}`,
      );
    }
  }

  const adHocSign = runTool("codesign", ["--force", "--sign", "-", targetPath]);
  if (!adHocSign.ok) {
    throw new Error(
      `codesign ad-hoc signing failed for ${path.basename(targetPath)}: ${adHocSign.message}`,
    );
  }

  const verify = runTool("codesign", ["--verify", "--verbose=2", targetPath]);
  if (!verify.ok) {
    throw new Error(
      `codesign verify failed for ${path.basename(targetPath)}: ${verify.message}`,
    );
  }
}

fs.mkdirSync(outDir, { recursive: true });

const expectedChecksums = loadChecksums();
const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
if (
  provenance.schemaVersion !== 1 ||
  !/^\d+\.\d+$/.test(provenance.version) ||
  provenance.officialDownloadPage !== "https://www.7-zip.org/download.html"
) {
  throw new Error("7z-provenance.json has invalid release metadata.");
}
for (const [name, source] of Object.entries(provenance.sourceArchives ?? {})) {
  if (
    !(
      /^https:\/\/www\.7-zip\.org\/a\//.test(source.url) ||
      /^https:\/\/github\.com\/ip7z\/7zip\/releases\/download\//.test(
        source.url,
      )
    ) ||
    !/^[a-f0-9]{64}$/.test(source.sha256)
  ) {
    throw new Error(`Invalid official archive provenance for ${name}.`);
  }
}
for (const source of Object.keys(expectedChecksums)) {
  const record = provenance.artifacts?.[source];
  if (!record?.member || !provenance.sourceArchives?.[record.source]) {
    throw new Error(`Missing archive/member provenance for ${source}.`);
  }
}
if (updateChecksums) {
  console.warn(
    "TRUST BOOTSTRAP: checksum updates trust local assets only after matching independently verified official archives extracted by system tar or the explicitly trusted 7-Zip.",
  );
  const requestedVersion = optionValue("--version");
  if (requestedVersion !== provenance.version) {
    throw new Error(
      `Checksum updates require --version ${provenance.version} after independently updating and verifying 7z-provenance.json.`,
    );
  }
  if (!verifyDownloadsDir) {
    throw new Error(
      "Checksum updates require --verify-downloads <directory> containing the official source archives.",
    );
  }
}
const trusted7zPath = verifyDownloadsDir
  ? validateTrusted7zPath(suppliedTrusted7z, {
      assetsDirectory: assetsDir,
      outputDirectory: outDir,
    })
  : undefined;
const regeneratedChecksums = {};

let copied = 0;
const requiredSources = new Set(requiredSourcesForHost());
const missingRequired = [...requiredSources].filter(
  (source) => !fs.existsSync(path.join(assetsDir, source)),
);
if (missingRequired.length > 0) {
  console.error(
    `FATAL: Missing required 7-Zip source(s) for this host: ${missingRequired.join(", ")}`,
  );
  process.exit(1);
}

for (const source of checksumOnlySources) {
  const sourcePath = path.join(assetsDir, source);
  if (!fs.existsSync(sourcePath)) {
    console.error(`FATAL: Missing checksum-only 7-Zip asset ${source}`);
    process.exit(1);
  }
  const sourceHash = sha256File(sourcePath);
  regeneratedChecksums[source] = sourceHash;
  if (!updateChecksums) {
    const expected = expectedChecksums[source];
    if (!expected) {
      console.error(
        `FATAL: No tracked checksum for ${source}. Update provenance, then run \`node scripts/prepare-7z.js --update-checksums --all --version ${provenance.version} --verify-downloads <download-directory> --trusted-7z <independently-trusted-7z-path>\`.`,
      );
      process.exit(1);
    }
    if (expected !== sourceHash) {
      console.error(
        `Checksum mismatch for ${source}\n  expected ${expected}\n  actual   ${sourceHash}`,
      );
      process.exit(1);
    }
  }
}

for (const mapping of mappings) {
  const sourcePath = path.join(assetsDir, mapping.source);
  const targetPath = path.join(outDir, mapping.target);

  if (!fs.existsSync(sourcePath)) {
    if (requiredSources.has(mapping.source)) {
      console.error(`FATAL: Missing required ${mapping.source}`);
      process.exit(1);
    }
    console.warn(`Missing optional ${mapping.source}`);
    continue;
  }

  // Verify the source asset against the tracked manifest before trusting it.
  const sourceHash = sha256File(sourcePath);
  regeneratedChecksums[mapping.source] = sourceHash;
  if (!updateChecksums) {
    const expected = expectedChecksums[mapping.source];
    if (expected && expected !== sourceHash) {
      console.error(
        `Checksum mismatch for ${mapping.source}\n  expected ${expected}\n  actual   ${sourceHash}`,
      );
      process.exit(1);
    }
    if (!expected) {
      console.error(
        `FATAL: No tracked checksum for ${mapping.source}. Update provenance, then run \`node scripts/prepare-7z.js --update-checksums --all --version ${provenance.version} --verify-downloads <download-directory> --trusted-7z <independently-trusted-7z-path>\`.`,
      );
      process.exit(1);
    }
  }

  fs.copyFileSync(sourcePath, targetPath);
  console.log(`  ${mapping.target}: sha256=${sourceHash}`);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(targetPath, 0o755);
    } catch {}
  }
  if (
    process.platform === "darwin" &&
    mapping.target.includes("apple-darwin")
  ) {
    sanitizeMacSidecar(targetPath);
  }
  copied += 1;
}

if (copied === 0) {
  console.error("No 7-Zip binaries found in assets/.");
  process.exit(1);
}

function verifyOfficialDownloads(downloadDirectory) {
  const extractionRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "zinnia-7z-provenance-"),
  );
  try {
    for (const [sourceName, source] of Object.entries(
      provenance.sourceArchives,
    )) {
      const archiveName = path.basename(new URL(source.url).pathname);
      const archivePath = path.join(downloadDirectory, archiveName);
      if (!fs.existsSync(archivePath)) {
        throw new Error(`Missing official source archive ${archivePath}.`);
      }
      const actualArchiveHash = sha256File(archivePath);
      if (actualArchiveHash !== source.sha256) {
        throw new Error(
          `Official archive checksum mismatch for ${archiveName}: expected ${source.sha256}, got ${actualArchiveHash}.`,
        );
      }
      const destination = path.join(extractionRoot, sourceName);
      fs.mkdirSync(destination);
      assertOfficialArchiveMembersSafe({
        archivePath,
        destination,
        trusted7zPath,
      });
      const extractionCommand = officialArchiveExtractionCommand({
        archivePath,
        destination,
        trusted7zPath,
      });
      const extraction = runTool(
        extractionCommand.command,
        extractionCommand.args,
      );
      if (!extraction.ok) {
        throw new Error(
          `Could not extract official archive ${archiveName}: ${extraction.message}`,
        );
      }
      assertExtractedTreeContained(destination);
    }
    for (const [asset, record] of Object.entries(provenance.artifacts)) {
      const extracted = path.join(extractionRoot, record.source, record.member);
      if (!fs.existsSync(extracted)) {
        throw new Error(`Official archive is missing ${record.member}.`);
      }
      const expected = regeneratedChecksums[asset] ?? expectedChecksums[asset];
      const actual = sha256File(extracted);
      if (actual !== expected) {
        throw new Error(
          `Tracked ${asset} does not match ${record.source}/${record.member}: expected ${expected}, got ${actual}.`,
        );
      }
    }
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
  console.log(`Verified official 7-Zip ${provenance.version} source archives.`);
}

if (verifyDownloadsDir) {
  verifyOfficialDownloads(path.resolve(verifyDownloadsDir));
}

if (updateChecksums) {
  const sorted = Object.fromEntries(
    Object.keys(regeneratedChecksums)
      .sort()
      .map((key) => [key, regeneratedChecksums[key]]),
  );
  fs.writeFileSync(checksumPath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Wrote ${checksumPath}`);
}

console.log(`Prepared ${copied} 7z binaries.`);
