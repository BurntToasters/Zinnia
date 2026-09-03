import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  REPO_ROOT,
  createE2eProfile,
  e2eBinaryPath,
  e2eStampPath,
} from "../e2e/helpers/profile.js";

import { usesWindowsCmdShell } from "./npm-safe-update.mjs";

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function e2eChildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // Cursor/CI helper envs must not redirect the e2e binary away from
  // src-tauri/target/debug, where the stamp and WDIO launcher look.
  delete env.CARGO_TARGET_DIR;
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: e2eChildEnv(options.env),
    stdio: "inherit",
    windowsHide: true,
    encoding: "utf8",
    shell: usesWindowsCmdShell(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}`,
    );
  }
}

function which(bin) {
  const result = spawnSync(
    process.platform === "win32" ? "where" : "which",
    [bin],
    { encoding: "utf8", windowsHide: true },
  );
  return result.status === 0;
}

function needsXvfb() {
  return (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  );
}

function reexecUnderXvfb() {
  if (process.env.ZINNIA_E2E_XVFB === "1") return false;
  if (!needsXvfb()) return false;
  if (!which("xvfb-run")) {
    throw new Error(
      "Linux E2E needs a display. Install xvfb and retry, or set DISPLAY.",
    );
  }
  const result = spawnSync(
    "xvfb-run",
    [
      "-a",
      process.execPath,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ZINNIA_E2E_XVFB: "1" },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function e2eBinaryIsFresh() {
  const binary = e2eBinaryPath();
  const stamp = e2eStampPath();
  if (!fs.existsSync(binary) || !fs.existsSync(stamp)) return false;
  const expected = "e2e-feature-3\n";
  if (fs.readFileSync(stamp, "utf8") !== expected) return false;
  // cargo test / clippy rebuild target/debug/zinnia without --features e2e.
  return fs.statSync(stamp).mtimeMs >= fs.statSync(binary).mtimeMs;
}

function buildE2eBinary() {
  run(npmCommand(), ["run", "prepare:7z"]);
  run(npxCommand(), [
    "tauri",
    "build",
    "--debug",
    "--no-bundle",
    "--config",
    path.join(REPO_ROOT, "src-tauri", "tauri.e2e.conf.json"),
    "--",
    "--features",
    "e2e",
  ]);
  const binary = e2eBinaryPath();
  if (!fs.existsSync(binary)) {
    throw new Error(`E2E binary missing after build: ${binary}`);
  }
  fs.mkdirSync(path.dirname(e2eStampPath()), { recursive: true });
  fs.writeFileSync(e2eStampPath(), "e2e-feature-3\n");
}

function runWdio(profile, spec, appArgs) {
  const env = {
    ...process.env,
    ...profile.env,
    ZINNIA_E2E: "1",
    ZINNIA_E2E_BINARY: e2eBinaryPath(),
    ZINNIA_E2E_APP_ARGS: JSON.stringify(appArgs),
    ZINNIA_E2E_SPECS: spec,
    ZINNIA_E2E_WORK: profile.work,
    ZINNIA_E2E_HELLO_TXT: profile.copies["hello.txt"],
    ZINNIA_E2E_HELLO_7Z: profile.copies["hello.7z"],
    ZINNIA_E2E_HELLO_ZIP: profile.copies["hello.zip"],
    ZINNIA_E2E_NESTED_ZIP: profile.copies["nested.zip"],
    ZINNIA_E2E_ENCRYPTED_7Z: profile.copies["encrypted.7z"],
    ZINNIA_E2E_EXTRACT_OUT: profile.copies.extractOut,
    ZINNIA_E2E_EXTRACT_OUT_ZIP: profile.copies.extractOutZip,
    ZINNIA_E2E_EXTRACT_OUT_NESTED: profile.copies.extractOutNested,
    ZINNIA_E2E_EXTRACT_OUT_ENCRYPTED: profile.copies.extractOutEncrypted,
    ZINNIA_E2E_COMPRESS_OUT: profile.copies.compressOut,
    ZINNIA_E2E_PAYLOAD: profile.manifest.payloadText,
    ZINNIA_E2E_PASSWORD: profile.manifest.password,
  };
  if (spec.includes("extract-window")) {
    env.ZINNIA_E2E_WINDOW_LABEL = "extract-0";
  }
  run(npxCommand(), ["wdio", "run", "e2e/wdio.conf.js"], { env });
}

function main() {
  if (process.env.SKIP_E2E === "1") {
    throw new Error(
      "SKIP_E2E=1 is not allowed. Unset it and run the unpackaged WebdriverIO suite.",
    );
  }
  reexecUnderXvfb();
  if (!e2eBinaryIsFresh() || process.env.ZINNIA_E2E_REBUILD === "1") {
    buildE2eBinary();
  }
  const profile = createE2eProfile();
  try {
    runWdio(profile, "./specs/main.spec.js", []);
    runWdio(profile, "./specs/extract-window.spec.js", [
      "--extract",
      profile.copies["hello.7z"],
    ]);
  } finally {
    fs.rmSync(profile.profileDir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}
