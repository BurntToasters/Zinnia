import fs from "fs";
import crypto from "crypto";
import path from "path";
import { spawnSync } from "child_process";

const root = process.cwd();
const assetsDir = path.join(root, "assets");
const outDir = path.join(root, "src-tauri", "binaries");
const checksumPath = path.join(assetsDir, "7z-checksums.json");
const updateChecksums = process.argv.includes("--update-checksums");

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function loadChecksums() {
  if (!fs.existsSync(checksumPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(checksumPath, "utf8"));
  } catch (err) {
    console.warn(`Could not read 7z-checksums.json: ${err.message}`);
    return {};
  }
}

const mappings = [
  { source: "win/x64/7za.exe", target: "7z-x86_64-pc-windows-msvc.exe" },
  { source: "win/arm64/7za.exe", target: "7z-aarch64-pc-windows-msvc.exe" },
  { source: "mac/7zz", target: "7z-x86_64-apple-darwin" },
  { source: "mac/7zz", target: "7z-aarch64-apple-darwin" },
  { source: "mac/7zz", target: "7z-universal-apple-darwin" },
  { source: "linux/x64/7zzs", target: "7z-x86_64-unknown-linux-gnu" },
  { source: "linux/arm64/7zzs", target: "7z-aarch64-unknown-linux-gnu" },
];

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
const regeneratedChecksums = {};

let copied = 0;

for (const mapping of mappings) {
  const sourcePath = path.join(assetsDir, mapping.source);
  const targetPath = path.join(outDir, mapping.target);

  if (!fs.existsSync(sourcePath)) {
    console.warn(`Missing ${mapping.source}`);
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
      console.warn(
        `No tracked checksum for ${mapping.source}; run "node scripts/prepare-7z.js --update-checksums" after verifying the binary.`,
      );
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
