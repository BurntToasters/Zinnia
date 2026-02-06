import fs from "fs";
import path from "path";

const root = process.cwd();
const pkgRoot = path.join(root, "node_modules", "7zip-bin");
const outDir = path.join(root, "src-tauri", "binaries");

const mappings = [
  { source: "win/x64/7za.exe", target: "7z-x86_64-pc-windows-msvc.exe" },
  { source: "win/arm64/7za.exe", target: "7z-aarch64-pc-windows-msvc.exe" },
  { source: "mac/x64/7za", target: "7z-x86_64-apple-darwin" },
  { source: "mac/arm64/7za", target: "7z-aarch64-apple-darwin" },
  { source: "linux/x64/7za", target: "7z-x86_64-unknown-linux-gnu" },
  { source: "linux/arm64/7za", target: "7z-aarch64-unknown-linux-gnu" }
];

fs.mkdirSync(outDir, { recursive: true });

let copied = 0;

for (const mapping of mappings) {
  const sourcePath = path.join(pkgRoot, mapping.source);
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
  console.error("No 7zip-bin binaries found. Run npm install first.");
  process.exit(1);
}

console.log(`Prepared ${copied} 7z binaries.`);
