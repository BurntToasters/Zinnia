import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const ZIPS_DIR = path.join(REPO_ROOT, "zips");
export const APP_ID = "run.rosie.zinnia";

export function loadArchiveManifest(repoRoot = REPO_ROOT) {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, "zips", "manifest.json"), "utf8"),
  );
}

export function hostBinaryName(platform = process.platform) {
  return platform === "win32" ? "zinnia.exe" : "zinnia";
}

export function e2eBinaryPath(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, "src-tauri", "target", "debug", hostBinaryName());
}

export function e2eStampPath(repoRoot = REPO_ROOT) {
  return path.join(
    repoRoot,
    "src-tauri",
    "target",
    "debug",
    ".zinnia-e2e-stamp",
  );
}

export function seedE2eSettings(settingsDir) {
  fs.mkdirSync(settingsDir, { recursive: true });
  const settings = {
    setupComplete: true,
    _setupComplete: true,
    _setupWizardVersion: 3,
    autoCheckUpdates: false,
    quickExtractKeepWarm: false,
    extractAutoCloseSeconds: -1,
    workspaceMode: "basic",
    basicWindowEffects: false,
    debug: false,
  };
  fs.writeFileSync(
    path.join(settingsDir, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
}

export function settingsDirForProfile(profileDir, platform = process.platform) {
  if (platform === "darwin") {
    return path.join(
      profileDir,
      "home",
      "Library",
      "Application Support",
      APP_ID,
    );
  }
  if (platform === "win32") {
    return path.join(profileDir, "AppData", "Roaming", APP_ID);
  }
  return path.join(profileDir, "data", APP_ID);
}

export function createE2eProfile(repoRoot = REPO_ROOT) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "zinnia-e2e-"));
  const home = path.join(profileDir, "home");
  const data = path.join(profileDir, "data");
  const config = path.join(profileDir, "config");
  const work = path.join(profileDir, "work");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  seedE2eSettings(settingsDirForProfile(profileDir));
  if (process.platform === "win32") {
    seedE2eSettings(path.join(profileDir, "AppData", "Local", APP_ID));
  }
  const manifest = loadArchiveManifest(repoRoot);
  const copies = {};
  const zipsDir = path.join(repoRoot, "zips");
  for (const name of [manifest.payloadFile, "hello.7z"]) {
    const dest = path.join(work, name);
    fs.copyFileSync(path.join(zipsDir, name), dest);
    copies[name] = dest;
  }
  copies.extractOut = path.join(work, "extract-out");
  copies.compressOut = path.join(work, `hello-e2e.7z`);
  fs.mkdirSync(copies.extractOut, { recursive: true });
  const env = {
    ZINNIA_E2E: "1",
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: path.join(profileDir, "state"),
    XDG_CACHE_HOME: path.join(profileDir, "cache"),
    APPDATA: path.join(profileDir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(profileDir, "AppData", "Local"),
  };
  if (process.platform === "linux") {
    env.WEBKIT_DISABLE_COMPOSITING_MODE = "1";
  }
  return { profileDir, work, copies, env, manifest };
}
