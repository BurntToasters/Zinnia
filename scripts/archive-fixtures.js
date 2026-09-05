import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, "..");
export const ZIPS_DIR = path.join(REPO_ROOT, "zips");
export const MANIFEST_PATH = path.join(ZIPS_DIR, "manifest.json");

export const CREATE_MATRIX = [
  {
    format: "7z",
    extension: "7z",
    methodSwitches: ["-m0=lzma2", "-md=64m", "-mfb=64"],
  },
  {
    format: "zip",
    extension: "zip",
    methodSwitches: ["-m0=deflate", "-mfb=64"],
  },
  { format: "tar", extension: "tar", methodSwitches: [] },
  { format: "gzip", extension: "gz", methodSwitches: ["-mfb=64"] },
  { format: "bzip2", extension: "bz2", methodSwitches: [] },
  { format: "xz", extension: "xz", methodSwitches: ["-md=64m", "-mfb=64"] },
];

/** Formats the UI can update in place (`addFilesToArchive`). */
export const UPDATE_FORMATS = ["7z", "zip", "tar"];

/** Extract switches from `buildSelectiveExtractArgs` (Rust still injects `-snld10`). */
export const APP_EXTRACT_SWITCHES = ["-aou", "-bb1", "-spd", "-bsp1"];

/** Browse listing from `browseArchive`. */
export const APP_LIST_SWITCHES = ["l", "-slt", "-spd"];

/** Integrity test from `testArchive`. */
export const APP_TEST_SWITCHES = ["t", "-spd"];

/** Add-to-existing from `addFilesToArchive`. */
export const APP_UPDATE_SWITCHES = ["u", "-sse", "-snl", "-snh", "-spd"];

/** Create/convert prefix from `buildArgs` / `convertArchive`. */
export const APP_CREATE_PREFIX = ["-sse", "-snl", "-snh", "-spd"];

export function passwordArgs(password) {
  return password ? [`-p${password}`] : [];
}

/** Member `Path =` values from `7z l -slt` (skips the archive-header Path). */
export function parseSltMemberPaths(stdout) {
  const paths = [];
  let inFiles = false;
  for (const raw of String(stdout).split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("----------")) {
      inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    const eqIdx = raw.indexOf(" = ");
    if (eqIdx === -1) continue;
    if (raw.substring(0, eqIdx).trim() !== "Path") continue;
    const value = raw.substring(eqIdx + 3);
    if (value) paths.push(value);
  }
  return paths;
}

export function listingHasMember(stdout, memberPath) {
  const wantedPosix = String(memberPath)
    .split(/[/\\]/)
    .filter(Boolean)
    .join("/");
  return parseSltMemberPaths(stdout).some((entry) => {
    const normalized = entry.split(/[/\\]/).filter(Boolean).join("/");
    return normalized === wantedPosix || entry === memberPath;
  });
}

/** Match `harden_7z_args` so Windows listings use UTF-8 member names. */
export function hardenFixture7zArgs(args, platform = process.platform) {
  const next = [...args];
  const command = next[0];
  if (platform === "win32" && ["a", "u", "x", "l", "t"].includes(command)) {
    for (let i = next.length - 1; i >= 0; i -= 1) {
      if (String(next[i]).toLowerCase().startsWith("-scc")) {
        next.splice(i, 1);
      }
    }
    const insertAt = next.indexOf("--");
    next.splice(insertAt === -1 ? next.length : insertAt, 0, "-sccUTF-8");
  }
  if (["a", "u"].includes(command)) {
    const separator = next.indexOf("--");
    const optionEnd = separator === -1 ? next.length : separator;
    const zipTyped = next
      .slice(1, optionEnd)
      .some((arg) => String(arg).toLowerCase() === "-tzip");
    const zipPath = [...next.slice(1, optionEnd)]
      .reverse()
      .find((arg) => !String(arg).startsWith("-"));
    if (
      zipTyped ||
      String(zipPath || "")
        .toLowerCase()
        .endsWith(".zip")
    ) {
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const lower = String(next[i]).toLowerCase();
        if (lower.startsWith("-mcu") || lower.startsWith("-mcl")) {
          next.splice(i, 1);
        }
      }
      const insertAt = next.indexOf("--");
      next.splice(insertAt === -1 ? next.length : insertAt, 0, "-mcu=on");
    }
  }
  return next;
}

export function loadArchiveManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

export function nodeArchToSidecarArch(nodeArch = process.arch) {
  if (nodeArch === "arm64") return "aarch64";
  if (nodeArch === "x64") return "x86_64";
  return nodeArch;
}

export function hostSidecarNames(
  platform = process.platform,
  arch = process.arch,
) {
  const sidecarArch = nodeArchToSidecarArch(arch);
  if (platform === "win32") {
    return [`7z-${sidecarArch}-pc-windows-msvc.exe`];
  }
  if (platform === "darwin") {
    return [`7z-${sidecarArch}-apple-darwin`, "7z-universal-apple-darwin"];
  }
  return [`7z-${sidecarArch}-unknown-linux-gnu`];
}

export function findHostSidecar(repoRoot = REPO_ROOT) {
  const dir = path.join(repoRoot, "src-tauri", "binaries");
  for (const name of hostSidecarNames()) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function requireHostSidecar(repoRoot = REPO_ROOT) {
  const sidecar = findHostSidecar(repoRoot);
  if (!sidecar) {
    throw new Error(
      "bundled 7z sidecar not found in src-tauri/binaries (run npm run prepare:7z)",
    );
  }
  return sidecar;
}

export function run7z(sidecar, args, options = {}) {
  const hardened = hardenFixture7zArgs(args);
  const result = spawnSync(sidecar, hardened, {
    encoding: "buffer",
    stdio: options.input != null ? "pipe" : ["ignore", "pipe", "pipe"],
    windowsHide: true,
    cwd: options.cwd,
    input: options.input,
    timeout: options.timeout ?? 120_000,
  });
  const stdout = result.stdout ? result.stdout.toString("utf8") : "";
  const stderr = result.stderr ? result.stderr.toString("utf8") : "";
  if (result.error) {
    const error = new Error(
      `7z failed to start: ${result.error.message}\n${stderr}`,
    );
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
  const code = result.status ?? 1;
  if (options.allowFailure) {
    return { code, stdout, stderr };
  }
  if (code !== 0) {
    const error = new Error(
      `7z ${hardened[0] ?? ""} exited ${code}: ${stderr || stdout}`,
    );
    error.code = code;
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
  return { code, stdout, stderr };
}

function crc16OfHeader(bytes) {
  return crc32(bytes) & 0xffff;
}

function writeU16(buffer, offset, value) {
  buffer.writeUInt16LE(value, offset);
}

function writeU32(buffer, offset, value) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

/** Stored RAR 1.5/4 archive. Bundled 7-Zip cannot write RAR. */
export function buildStoredRar4(fileName, content) {
  const nameBytes = Buffer.from(fileName, "utf8");
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const signature = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);

  const main = Buffer.alloc(13);
  main[2] = 0x73;
  writeU16(main, 3, 0);
  writeU16(main, 5, 13);
  writeU16(main, 0, crc16OfHeader(main.subarray(2)));

  const fileHeaderSize = 32 + nameBytes.length;
  const fileHeader = Buffer.alloc(fileHeaderSize);
  fileHeader[2] = 0x74;
  writeU16(fileHeader, 3, 0x8000);
  writeU16(fileHeader, 5, fileHeaderSize);
  writeU32(fileHeader, 7, data.length);
  writeU32(fileHeader, 11, data.length);
  fileHeader[15] = 3;
  writeU32(fileHeader, 16, crc32(data) >>> 0);
  writeU32(fileHeader, 20, 0);
  fileHeader[24] = 20;
  fileHeader[25] = 0x30;
  writeU16(fileHeader, 26, nameBytes.length);
  writeU32(fileHeader, 28, 0o100644);
  nameBytes.copy(fileHeader, 32);
  writeU16(fileHeader, 0, crc16OfHeader(fileHeader.subarray(2)));

  const end = Buffer.alloc(7);
  end[2] = 0x7b;
  writeU16(end, 3, 0);
  writeU16(end, 5, 7);
  writeU16(end, 0, crc16OfHeader(end.subarray(2)));

  return Buffer.concat([signature, main, fileHeader, data, end]);
}

export function makeTempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zinnia-${tag}-`));
}

export function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    files.push(current);
  }
  return files;
}

export function posixJoin(parts) {
  return parts.join("/");
}

export function findMemberFile(extractRoot, memberPath) {
  const expected = memberPath.split(/[/\\]/).filter(Boolean);
  const expectedPosix = posixJoin(expected);
  const files = walkFiles(extractRoot);
  const match = files.find((file) => {
    const relative = path.relative(extractRoot, file).split(path.sep).join("/");
    return relative === expectedPosix;
  });
  return match ?? null;
}

export function randomBytesFile(filePath, size) {
  fs.writeFileSync(filePath, crypto.randomBytes(size));
}
