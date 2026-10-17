import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const ZIPS_DIR = path.join(REPO_ROOT, "zips");
export const APP_ID = "run.rosie.zinnia";
const permanentDisabledFeatures = [
  "CalculateNativeWinOcclusion",
  "RendererCodeIntegrity",
];
// TEMP_WEBVIEW2_LOCKOUT_WORKAROUND: TEMPORARY UPSTREAM WORKAROUND, REMOVE after
// the fixed stable WebView2 runtime is verified to no longer log Event 4625 on
// fresh environment creation; see e2e/webview2-lockout.failure-modes.md.
// Cause: a fresh WebView2 environment can generate a failed Windows interactive
// logon, and repeated E2E launches increment the bad-password counter (lockout).
// Tracking: MicrosoftEdge/WebView2Feedback #5722, Chromium #562403601.
// Chromium runs the probe when either feature is enabled
// (chrome_autofill_client.cc).
const temporaryRegressionWorkarounds = [
  "AutofillAiWalletPrivatePasses",
  "AutofillAmbientAutofill",
];
export const E2E_WEBVIEW2_BROWSER_ARGS = `--disable-gpu --disable-features=${[
  ...permanentDisabledFeatures,
  ...temporaryRegressionWorkarounds,
].join(",")}`;

const WEBVIEW2_FEATURE_SWITCH_PREFIXES = [
  "--disable-features=",
  "--enable-features=",
];

/**
 * Merges WebView2 browser-argument strings. Each --disable-features= and
 * --enable-features= is folded into one switch; other switches are kept once.
 * Order follows first occurrence. Empty and non-string inputs are skipped.
 */
export function mergeWebView2BrowserArgs(...argStrings) {
  const entries = [];
  const featureLists = new Map();
  const seenSwitches = new Set();
  for (const argString of argStrings) {
    if (typeof argString !== "string" || argString.trim() === "") continue;
    for (const token of argString.trim().split(/\s+/)) {
      const prefix = WEBVIEW2_FEATURE_SWITCH_PREFIXES.find((candidate) =>
        token.startsWith(candidate),
      );
      if (prefix) {
        let list = featureLists.get(prefix);
        if (!list) {
          list = { features: [], seen: new Set() };
          featureLists.set(prefix, list);
          entries.push({ prefix });
        }
        for (const part of token.slice(prefix.length).split(",")) {
          const feature = part.trim();
          if (feature && !list.seen.has(feature)) {
            list.seen.add(feature);
            list.features.push(feature);
          }
        }
      } else if (!seenSwitches.has(token)) {
        seenSwitches.add(token);
        entries.push({ token });
      }
    }
  }
  const merged = [];
  for (const entry of entries) {
    if (entry.token !== undefined) {
      merged.push(entry.token);
      continue;
    }
    const { features } = featureLists.get(entry.prefix);
    if (features.length > 0) {
      merged.push(`${entry.prefix}${features.join(",")}`);
    }
  }
  return merged.join(" ");
}

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

export function updateE2eSettings(
  profileDir,
  overrides,
  platform = process.platform,
) {
  const dirs = [settingsDirForProfile(profileDir, platform)];
  if (platform === "win32") {
    dirs.push(windowsProfilePaths(path.join(profileDir, "home")).settingsLocal);
  }
  for (const dir of dirs) {
    const file = path.join(dir, "settings.json");
    if (!fs.existsSync(file)) continue;
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(
      file,
      `${JSON.stringify({ ...current, ...overrides }, null, 2)}\n`,
    );
  }
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
    return path.join(profileDir, "home", "AppData", "Roaming", APP_ID);
  }
  return path.join(profileDir, "data", APP_ID);
}

/** Standard Windows layout: AppData lives under USERPROFILE, not beside it. */
export function windowsProfilePaths(home) {
  const roaming = path.join(home, "AppData", "Roaming");
  const local = path.join(home, "AppData", "Local");
  return {
    roaming,
    local,
    settingsRoaming: path.join(roaming, APP_ID),
    settingsLocal: path.join(local, APP_ID),
    webview2: path.join(local, "ZinniaWebView2"),
  };
}

export function windowsHomeDriveAndPath(homeAbs, pathImpl = path) {
  const parsed = pathImpl.parse(homeAbs);
  const drive = (parsed.root || "C:\\").replace(/[\\/]+$/, "") || "C:";
  let rest = homeAbs.slice(parsed.root.length).replace(/[/\\]+/g, "\\");
  if (rest.startsWith("\\")) rest = rest.slice(1);
  return {
    HOMEDRIVE: drive,
    HOMEPATH: rest ? `\\${rest}` : "\\",
  };
}

export function createE2eProfile(
  repoRoot = REPO_ROOT,
  platform = process.platform,
) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "zinnia-e2e-"));
  const home = path.join(profileDir, "home");
  const data = path.join(profileDir, "data");
  const config = path.join(profileDir, "config");
  const work = path.join(profileDir, "work");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  seedE2eSettings(settingsDirForProfile(profileDir, platform));
  let windowsPaths = null;
  if (platform === "win32") {
    windowsPaths = windowsProfilePaths(home);
    fs.mkdirSync(windowsPaths.webview2, { recursive: true });
    seedE2eSettings(windowsPaths.settingsLocal);
  }
  const manifest = loadArchiveManifest(repoRoot);
  const copies = {};
  const zipsDir = path.join(repoRoot, "zips");
  for (const name of [
    manifest.payloadFile,
    "hello.7z",
    "hello.zip",
    "nested.zip",
    "encrypted.7z",
  ]) {
    const dest = path.join(work, name);
    fs.copyFileSync(path.join(zipsDir, name), dest);
    copies[name] = dest;
  }
  copies.extractOut = path.join(work, "extract-out");
  copies.extractOutZip = path.join(work, "extract-out-zip");
  copies.extractOutNested = path.join(work, "extract-out-nested");
  copies.extractOutEncrypted = path.join(work, "extract-out-encrypted");
  copies.compressOut = path.join(work, `hello-e2e.7z`);
  const env = {
    ZINNIA_E2E: "1",
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: path.join(profileDir, "state"),
    XDG_CACHE_HOME: path.join(profileDir, "cache"),
    APPDATA: windowsPaths
      ? windowsPaths.roaming
      : path.join(profileDir, "AppData", "Roaming"),
    LOCALAPPDATA: windowsPaths
      ? windowsPaths.local
      : path.join(profileDir, "AppData", "Local"),
  };
  if (windowsPaths) {
    env.WEBVIEW2_USER_DATA_FOLDER = windowsPaths.webview2;
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = mergeWebView2BrowserArgs(
      process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
      E2E_WEBVIEW2_BROWSER_ARGS,
    );
    if (process.platform === "win32") {
      Object.assign(env, windowsHomeDriveAndPath(home));
    }
  }
  if (platform === "linux") {
    env.WEBKIT_DISABLE_COMPOSITING_MODE = "1";
  }
  return { profileDir, work, copies, env, manifest };
}
