import fs from "fs";
import path from "path";

const root = process.cwd();
const assetsDir = path.join(root, "assets");
const outDir = path.join(root, "src-tauri", "binaries");

const mappings = [
  { source: "win/x64/7za.exe", target: "7z-x86_64-pc-windows-msvc.exe" },
  { source: "win/arm64/7za.exe", target: "7z-aarch64-pc-windows-msvc.exe" },
  { source: "mac/7zz", target: "7z-x86_64-apple-darwin" },
  { source: "mac/7zz", target: "7z-aarch64-apple-darwin" },
  { source: "linux/x64/7zzs", target: "7z-x86_64-unknown-linux-gnu" },
  { source: "linux/arm64/7zzs", target: "7z-aarch64-unknown-linux-gnu" }
];

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
  copied += 1;
}

if (copied === 0) {
  console.error("No 7-Zip binaries found in assets/.");
  process.exit(1);
}

console.log(`Prepared ${copied} 7z binaries.`);
