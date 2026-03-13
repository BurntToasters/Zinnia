import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const root = process.cwd();
const assetsDir = path.join(root, "assets");
const outDir = path.join(root, "src-tauri", "binaries");

const mappings = [
  { source: "win/x64/7za.exe", target: "7z-x86_64-pc-windows-msvc.exe" },
  { source: "win/arm64/7za.exe", target: "7z-aarch64-pc-windows-msvc.exe" },
  { source: "mac/7zz", target: "7z-x86_64-apple-darwin" },
  { source: "mac/7zz", target: "7z-aarch64-apple-darwin" },
  { source: "mac/7zz", target: "7z-universal-apple-darwin" },
  { source: "linux/x64/7zzs", target: "7z-x86_64-unknown-linux-gnu" },
  { source: "linux/arm64/7zzs", target: "7z-aarch64-unknown-linux-gnu" }
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
      message: stderr || stdout || `${command} exited with code ${result.status}`,
    };
  }
  return { ok: true, message: "" };
}

function sanitizeMacSidecar(targetPath) {
  const xattr = runTool("xattr", ["-cr", targetPath]);
  if (!xattr.ok) {
    const ignorable = /No such xattr|No such file|not found/i.test(xattr.message);
    if (!ignorable) {
      console.warn(`xattr cleanup failed for ${path.basename(targetPath)}: ${xattr.message}`);
    }
  }

  const removeSig = runTool("codesign", ["--remove-signature", targetPath]);
  if (!removeSig.ok) {
    const ignorable = /is not signed at all|code object is not signed/i.test(removeSig.message);
    if (!ignorable) {
      console.warn(
        `codesign signature cleanup failed for ${path.basename(targetPath)}: ${removeSig.message}`
      );
    }
  }
}

fs.mkdirSync(outDir, { recursive: true });

let copied = 0;

for (const mapping of mappings) {
  const sourcePath = path.join(assetsDir, mapping.source);
  const targetPath = path.join(outDir, mapping.target);

  if (!fs.existsSync(sourcePath)) {
    console.warn(`Missing ${mapping.source}`);
    continue;
  }

  fs.copyFileSync(sourcePath, targetPath);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(targetPath, 0o755);
    } catch {
    }
  }
  if (process.platform === "darwin" && mapping.target.includes("apple-darwin")) {
    sanitizeMacSidecar(targetPath);
  }
  copied += 1;
}

if (copied === 0) {
  console.error("No 7-Zip binaries found in assets/.");
  process.exit(1);
}

console.log(`Prepared ${copied} 7z binaries.`);
