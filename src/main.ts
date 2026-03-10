import { open, save, message, ask } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

const MAX_LOG_LINES = 1000;
const SAFE_URL_PATTERN = /^https?:\/\//i;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el as T;
}

function parseThreads(raw: string, fallback: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(1, Math.min(128, n));
}

interface UserSettings {
  format: string;
  level: string;
  method: string;
  dict: string;
  wordSize: string;
  solid: string;
  threads: number;
  pathMode: string;
  sfx: boolean;
  encryptHeaders: boolean;
  deleteAfter: boolean;
  autoCheckUpdates: boolean;
}

let SETTING_DEFAULTS: UserSettings = {
  format: "7z",
  level: "5",
  method: "lzma2",
  dict: "256m",
  wordSize: "64",
  solid: "16g",
  threads: 8,
  pathMode: "relative",
  sfx: false,
  encryptHeaders: false,
  deleteAfter: false,
  autoCheckUpdates: true,
};

let currentSettings: UserSettings = { ...SETTING_DEFAULTS };

async function loadSettings(): Promise<UserSettings> {
  try {
    const raw = await invoke<string>("load_settings");
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    return { ...SETTING_DEFAULTS, ...parsed };
  } catch {
    return { ...SETTING_DEFAULTS };
  }
}

async function saveSettings(settings: UserSettings): Promise<void> {
  await invoke("save_settings", { json: JSON.stringify(settings) });
}

function applySettingsToForm() {
  $<HTMLSelectElement>("format").value = currentSettings.format;
  $<HTMLSelectElement>("level").value = currentSettings.level;
  $<HTMLSelectElement>("method").value = currentSettings.method;
  $<HTMLSelectElement>("dict").value = currentSettings.dict;
  $<HTMLSelectElement>("word-size").value = currentSettings.wordSize;
  $<HTMLSelectElement>("solid").value = currentSettings.solid;
  $<HTMLInputElement>("threads").value = String(currentSettings.threads);
  $<HTMLSelectElement>("path-mode").value = currentSettings.pathMode;
  $<HTMLInputElement>("sfx").checked = currentSettings.sfx;
  $<HTMLInputElement>("encrypt-headers").checked = currentSettings.encryptHeaders;
  $<HTMLInputElement>("delete-after").checked = currentSettings.deleteAfter;
}

function populateSettingsModal() {
  $<HTMLSelectElement>("s-format").value = currentSettings.format;
  $<HTMLSelectElement>("s-level").value = currentSettings.level;
  $<HTMLSelectElement>("s-method").value = currentSettings.method;
  $<HTMLSelectElement>("s-dict").value = currentSettings.dict;
  $<HTMLSelectElement>("s-word-size").value = currentSettings.wordSize;
  $<HTMLSelectElement>("s-solid").value = currentSettings.solid;
  $<HTMLInputElement>("s-threads").value = String(currentSettings.threads);
  $<HTMLSelectElement>("s-path-mode").value = currentSettings.pathMode;
  $<HTMLInputElement>("s-sfx").checked = currentSettings.sfx;
  $<HTMLInputElement>("s-encrypt-headers").checked = currentSettings.encryptHeaders;
  $<HTMLInputElement>("s-delete-after").checked = currentSettings.deleteAfter;
  $<HTMLInputElement>("s-auto-check-updates").checked = currentSettings.autoCheckUpdates;
}

function readSettingsModal(): UserSettings {
  return {
    format: $<HTMLSelectElement>("s-format").value,
    level: $<HTMLSelectElement>("s-level").value,
    method: $<HTMLSelectElement>("s-method").value,
    dict: $<HTMLSelectElement>("s-dict").value,
    wordSize: $<HTMLSelectElement>("s-word-size").value,
    solid: $<HTMLSelectElement>("s-solid").value,
    threads: parseThreads($<HTMLInputElement>("s-threads").value, SETTING_DEFAULTS.threads),
    pathMode: $<HTMLSelectElement>("s-path-mode").value,
    sfx: $<HTMLInputElement>("s-sfx").checked,
    encryptHeaders: $<HTMLInputElement>("s-encrypt-headers").checked,
    deleteAfter: $<HTMLInputElement>("s-delete-after").checked,
    autoCheckUpdates: $<HTMLInputElement>("s-auto-check-updates").checked,
  };
}

function openSettingsModal() {
  populateSettingsModal();
  $("settings-overlay").hidden = false;
}

function closeSettingsModal() {
  $("settings-overlay").hidden = true;
}

const inputList = $("input-list");
const logEl = $("log");
const statusEl = $("status");
const progressEl = $("progress");
const versionLabel = $("version-label");
const platformLabel = $("platform-label");
const appEl = $("app");
const gridEl = document.querySelector<HTMLElement>(".grid")!;
const runBtn = $<HTMLButtonElement>("run-action");
const cancelBtn = $<HTMLButtonElement>("cancel-action");
const extractRunBtn = $<HTMLButtonElement>("extract-run");
const extractCancelBtn = $<HTMLButtonElement>("extract-cancel");

const inputs: string[] = [];
let statusTimeout: number | undefined;
let running = false;
let batchCancelled = false;
let osIntegrationEnabled = false;
let platformName = "";
let appIsPackaged = false;

const ARCHIVE_EXTENSIONS = new Set([
  ".7z", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".tbz2",
  ".xz", ".txz", ".rar",
]);

function isArchiveFile(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of ARCHIVE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

interface PresetConfig {
  format: string;
  level: string;
  method: string;
  dict: string;
  wordSize: string;
  solid: string;
}

const PRESETS: Record<string, PresetConfig> = {
  store: { format: "zip", level: "0", method: "deflate", dict: "16m", wordSize: "16", solid: "off" },
  quick: { format: "zip", level: "1", method: "deflate", dict: "16m", wordSize: "32", solid: "off" },
  balanced: { format: "7z", level: "5", method: "lzma2", dict: "64m", wordSize: "64", solid: "4g" },
  high: { format: "7z", level: "7", method: "lzma2", dict: "128m", wordSize: "64", solid: "16g" },
  ultra: { format: "7z", level: "9", method: "lzma2", dict: "512m", wordSize: "128", solid: "solid" },
};

interface BrowseEntry {
  path: string;
  size: number;
  packedSize: number;
  modified: string;
  isFolder: boolean;
}

interface ArchiveInfo {
  type: string;
  physicalSize: number;
  method: string;
  solid: boolean;
  entries: BrowseEntry[];
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "\u2014";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function parseArchiveListing(stdout: string): ArchiveInfo {
  const lines = stdout.split("\n");
  const info: ArchiveInfo = { type: "", physicalSize: 0, method: "", solid: false, entries: [] };
  let inArchiveInfo = false;
  let inFiles = false;
  let current: Partial<BrowseEntry> = {};

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (trimmed === "--") {
      inArchiveInfo = true;
      continue;
    }

    if (trimmed.startsWith("----------")) {
      if (!inFiles) {
        inArchiveInfo = false;
        inFiles = true;
      } else if (current.path !== undefined) {
        info.entries.push({
          path: current.path,
          size: current.size ?? 0,
          packedSize: current.packedSize ?? 0,
          modified: current.modified ?? "",
          isFolder: current.isFolder ?? false,
        });
        current = {};
      }
      continue;
    }

    const eqIdx = trimmed.indexOf(" = ");
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx);
    const value = trimmed.substring(eqIdx + 3);

    if (inArchiveInfo) {
      if (key === "Type") info.type = value;
      else if (key === "Physical Size") info.physicalSize = parseInt(value) || 0;
      else if (key === "Method") info.method = value;
      else if (key === "Solid") info.solid = value === "+";
    } else if (inFiles) {
      if (key === "Path") current.path = value;
      else if (key === "Size") current.size = parseInt(value) || 0;
      else if (key === "Packed Size") current.packedSize = parseInt(value) || 0;
      else if (key === "Modified") current.modified = value;
      else if (key === "Folder") current.isFolder = value === "+";
    }
  }

  if (current.path !== undefined) {
    info.entries.push({
      path: current.path,
      size: current.size ?? 0,
      packedSize: current.packedSize ?? 0,
      modified: current.modified ?? "",
      isFolder: current.isFolder ?? false,
    });
  }

  return info;
}

function trimLog() {
  const text = logEl.textContent || "";
  const lines = text.split("\n");
  if (lines.length > MAX_LOG_LINES) {
    logEl.textContent = lines.slice(lines.length - MAX_LOG_LINES).join("\n");
  }
}

function log(line: string) {
  const stamp = new Date().toLocaleTimeString();
  logEl.textContent += `[${stamp}] ${line}\n`;
  trimLog();
  logEl.scrollTop = logEl.scrollHeight;
}

function devLog(line: string) {
  if (import.meta.env.DEV) {
    log(line);
  }
}

function toggleActivity() {
  const isVisible = gridEl.classList.toggle("show-activity");
  $("toggle-activity").classList.toggle("is-active", isVisible);
}

function setStatus(text: string, autoResetMs?: number) {
  if (statusTimeout !== undefined) {
    clearTimeout(statusTimeout);
    statusTimeout = undefined;
  }
  statusEl.textContent = text;
  if (autoResetMs) {
    statusTimeout = window.setTimeout(() => {
      setStatus("Idle");
      progressEl.hidden = true;
    }, autoResetMs);
  }
}

function setProgress(text: string) {
  progressEl.textContent = text;
  progressEl.hidden = false;
}

function hideProgress() {
  progressEl.hidden = true;
}

function renderInputs() {
  inputList.innerHTML = "";
  if (inputs.length === 0) {
    const empty = document.createElement("div");
    const mode = getMode();
    empty.textContent = mode === "extract"
      ? "Select an archive file to extract."
      : mode === "browse"
      ? "Select an archive to preview its contents."
      : "Drop files here or use the buttons above.";
    empty.className = "list__empty";
    inputList.appendChild(empty);
    return;
  }

  inputs.forEach((path, index) => {
    const item = document.createElement("div");
    item.className = "list__item";
    const span = document.createElement("span");
    span.textContent = path;
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      inputs.splice(index, 1);
      renderInputs();
    });
    item.appendChild(span);
    item.appendChild(remove);
    inputList.appendChild(item);
  });
}

function splitArgs(raw: string) {
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const out: string[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(raw)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

const ALLOWED_EXTRA_PREFIXES = [
  "-m", "-x", "-i", "-ao", "-bb", "-bs", "-bt",
  "-scs", "-slt", "-sns", "-snl", "-sni", "-stl",
  "-slp", "-ssp", "-ssw", "-y", "-r", "-w",
];

function validateExtraArgs(args: string[]): void {
  const blocked = ["-sdel", "-p", "-mhe", "-o", "-si", "-so", "-t"];

  for (const arg of args) {
    if (!arg.startsWith("-")) {
      throw new Error(`Extra arguments must start with '-'. Invalid: ${arg}`);
    }

    const lower = arg.toLowerCase();
    if (blocked.some(b => lower.startsWith(b))) {
      throw new Error(
        `"${arg}" is not allowed in extra args. Use the dedicated fields instead.`
      );
    }

    if (!ALLOWED_EXTRA_PREFIXES.some(p => lower.startsWith(p))) {
      throw new Error(
        `Unknown argument "${arg}". Only recognized 7z switches are allowed.`
      );
    }
  }
}

function getMode(): "add" | "extract" | "browse" {
  const m = appEl.dataset.mode;
  if (m === "extract") return "extract";
  if (m === "browse") return "browse";
  return "add";
}

function buildExtractArgsFor(archive: string): string[] {
  const dest = $<HTMLInputElement>("extract-path").value.trim();
  const password = $<HTMLInputElement>("extract-password").value.trim();
  const extraArgs = splitArgs($<HTMLInputElement>("extract-extra-args").value.trim());
  if (extraArgs.length > 0) validateExtraArgs(extraArgs);

  if (!dest) throw new Error("Choose a destination folder.");

  const args = ["x", archive, `-o${dest}`, "-y"];
  if (password) args.push(`-p${password}`);
  args.push(...extraArgs);
  return args;
}

function buildArgs() {
  const mode = getMode();

  if (mode === "extract") {
    if (!inputs[0]) throw new Error("Select an archive to extract.");
    return buildExtractArgsFor(inputs[0]);
  }

  const extraArgs = splitArgs($<HTMLInputElement>("extra-args").value.trim());

  if (extraArgs.length > 0) {
    validateExtraArgs(extraArgs);
  }

  const outputPath = $<HTMLInputElement>("output-path").value.trim();
  if (!outputPath) {
    throw new Error("Choose an output archive path.");
  }
  if (inputs.length === 0) {
    throw new Error("Add at least one input.");
  }

  const format = $<HTMLSelectElement>("format").value;
  const level = $<HTMLSelectElement>("level").value;
  const method = $<HTMLSelectElement>("method").value;
  const dict = $<HTMLSelectElement>("dict").value;
  const wordSize = $<HTMLSelectElement>("word-size").value;
  const solid = $<HTMLSelectElement>("solid").value;
  const threadsRaw = $<HTMLInputElement>("threads").value;
  const threads = parseThreads(threadsRaw, SETTING_DEFAULTS.threads);
  const pathMode = $<HTMLSelectElement>("path-mode").value;
  const password = $<HTMLInputElement>("password").value.trim();
  const encryptHeaders = $<HTMLInputElement>("encrypt-headers").checked;
  const sfx = $<HTMLInputElement>("sfx").checked;
  const deleteAfter = $<HTMLInputElement>("delete-after").checked;

  const switches: string[] = [];
  switches.push(`-t${format}`);
  switches.push(`-mx=${level}`);
  if (method) switches.push(`-m0=${method}`);
  if (dict) switches.push(`-md=${dict}`);
  if (wordSize) switches.push(`-mfb=${wordSize}`);
  if (solid === "solid") {
    switches.push("-ms=on");
  } else if (solid !== "off") {
    switches.push(`-ms=${solid}`);
  }
  if (threads) switches.push(`-mmt=${threads}`);
  if (pathMode === "absolute") switches.push("-spf");
  if (password) switches.push(`-p${password}`);
  if (encryptHeaders) switches.push("-mhe=on");
  if (sfx) switches.push("-sfx");
  if (deleteAfter) switches.push("-sdel");

  const args = ["a", ...switches, outputPath, ...inputs, ...extraArgs];
  return args;
}

function setRunning(active: boolean) {
  running = active;
  const mode = getMode();
  if (mode === "add") {
    runBtn.disabled = active;
    if (active) runBtn.setAttribute("aria-busy", "true");
    else runBtn.removeAttribute("aria-busy");
    cancelBtn.hidden = !active;
  } else if (mode === "extract") {
    extractRunBtn.disabled = active;
    if (active) extractRunBtn.setAttribute("aria-busy", "true");
    else extractRunBtn.removeAttribute("aria-busy");
    extractCancelBtn.hidden = !active;
  } else {
    $<HTMLButtonElement>("browse-list").disabled = active;
    $<HTMLButtonElement>("browse-test").disabled = active;
    $<HTMLButtonElement>("browse-extract").disabled = active;
  }
}

async function runAction() {
  if (running) return;

  const mode = getMode();

  if (mode === "extract" && inputs.length > 1) {
    return runBatchExtract();
  }

  try {
    if (mode === "add") {
      const deleteAfter = $<HTMLInputElement>("delete-after").checked;
      if (deleteAfter) {
        const confirmed = await message(
          "This will permanently delete source files after compression. Continue?",
          { title: "Confirm deletion", kind: "warning", okLabel: "Delete files" }
        );
        if (!confirmed) return;
      }
    }

    let args: string[];
    if (mode === "extract") {
      if (!inputs[0]) throw new Error("Select an archive to extract.");
      args = buildExtractArgsFor(inputs[0]);
    } else {
      args = buildArgs();
    }

    const logSafe = args.map(a => a.startsWith("-p") ? "-p***" : a);
    devLog(`7z ${logSafe.join(" ")}`);

    setRunning(true);
    setStatus("Running");

    const result = await invoke<{ stdout: string; stderr: string; code: number }>("run_7z", { args });

    const outputLines = result.stdout.split('\n');
    for (const line of outputLines) {
      const percentMatch = line.match(/(\d+)%/);
      if (percentMatch) {
        setProgress(`${percentMatch[1]}%`);
      }
    }

    if (result.stdout) log(result.stdout.trim());
    if (result.stderr) log(result.stderr.trim());
    devLog(`Exit code: ${result.code}`);

    if (result.code !== 0) {
      log(`7z exited with code ${result.code}`);
      setStatus("Error", 3000);
      hideProgress();
    } else {
      setStatus("Done", 2000);
      hideProgress();
    }
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    log(`Error: ${messageText}`);
    setStatus("Error", 3000);
    hideProgress();
  } finally {
    setRunning(false);
  }
}

async function runBatchExtract() {
  try {
    const dest = $<HTMLInputElement>("extract-path").value.trim();
    if (!dest) throw new Error("Choose a destination folder.");

    batchCancelled = false;
    setRunning(true);
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < inputs.length; i++) {
      if (batchCancelled) break;

      const archive = inputs[i];
      setStatus(`Extracting ${i + 1} of ${inputs.length}`);

      try {
        const args = buildExtractArgsFor(archive);
        const logSafe = args.map(a => a.startsWith("-p") ? "-p***" : a);
        devLog(`7z ${logSafe.join(" ")}`);

        const result = await invoke<{ stdout: string; stderr: string; code: number }>("run_7z", { args });

        const outputLines = result.stdout.split('\n');
        for (const line of outputLines) {
          const percentMatch = line.match(/(\d+)%/);
          if (percentMatch) setProgress(`${percentMatch[1]}% (${i + 1}/${inputs.length})`);
        }

        if (result.stdout) log(result.stdout.trim());
        if (result.stderr) log(result.stderr.trim());

        if (result.code === 0) {
          succeeded++;
        } else {
          failed++;
          log(`Failed: ${archive} (exit code ${result.code})`);
        }
      } catch (err) {
        if (batchCancelled) break;
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        log(`Error extracting ${archive}: ${msg}`);
      }
    }

    hideProgress();
    if (batchCancelled) {
      setStatus("Batch cancelled", 3000);
    } else if (failed === 0) {
      setStatus(`Done \u2014 ${succeeded} archive(s) extracted`, 3000);
    } else {
      setStatus(`Done \u2014 ${succeeded} succeeded, ${failed} failed`, 4000);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error: ${msg}`);
    setStatus("Error", 3000);
    hideProgress();
  } finally {
    setRunning(false);
  }
}

async function cancelAction() {
  batchCancelled = true;
  try {
    await invoke("cancel_7z");
    log("Operation cancelled by user");
    setStatus("Cancelled", 2000);
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    devLog(`Cancel error: ${messageText}`);
  }
}

async function testArchive() {
  if (running) return;
  const archive = inputs[0];
  if (!archive) {
    await message("Select an archive to test.", { title: "No archive selected" });
    return;
  }

  const mode = getMode();
  const passwordField = mode === "browse" ? "browse-password" : "extract-password";
  const password = $<HTMLInputElement>(passwordField).value.trim();

  const args = ["t", archive];
  if (password) args.push(`-p${password}`);

  setRunning(true);
  setStatus("Testing archive integrity");

  try {
    const result = await invoke<{ stdout: string; stderr: string; code: number }>("run_7z", { args });

    if (result.stdout) log(result.stdout.trim());
    if (result.stderr) log(result.stderr.trim());

    if (result.code === 0) {
      setStatus("Integrity test passed", 3000);
      log("Archive integrity test: OK");
    } else {
      setStatus("Integrity test failed", 3000);
      log(`Archive integrity test: FAILED (exit code ${result.code})`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Test error: ${msg}`);
    setStatus("Error", 3000);
  } finally {
    setRunning(false);
  }
}

async function browseArchive() {
  if (running) return;
  const archive = inputs[0];
  if (!archive) {
    await message("Select an archive to browse.", { title: "No archive selected" });
    return;
  }

  const password = $<HTMLInputElement>("browse-password").value.trim();
  const args = ["l", "-slt", archive];
  if (password) args.push(`-p${password}`);

  setRunning(true);
  setStatus("Listing archive contents");

  try {
    const result = await invoke<{ stdout: string; stderr: string; code: number }>("run_7z", { args });

    if (result.code !== 0) {
      if (result.stderr) log(result.stderr.trim());
      setStatus("Failed to list archive", 3000);
      return;
    }

    const info = parseArchiveListing(result.stdout);
    renderBrowseTable(info);
    setStatus(`${info.entries.length} entries listed`, 3000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Browse error: ${msg}`);
    setStatus("Error", 3000);
  } finally {
    setRunning(false);
  }
}

function renderBrowseTable(info: ArchiveInfo) {
  const container = document.getElementById("browse-contents");
  if (!container) return;
  container.hidden = false;

  const summary = document.getElementById("browse-summary");
  if (summary) {
    const totalSize = info.entries.reduce((sum, e) => sum + e.size, 0);
    const totalPacked = info.entries.reduce((sum, e) => sum + e.packedSize, 0);
    const fileCount = info.entries.filter(e => !e.isFolder).length;
    const folderCount = info.entries.filter(e => e.isFolder).length;
    const parts: string[] = [];
    parts.push(`<strong>${escapeHtml(info.type || "Archive")}</strong>`);
    if (info.method) parts.push(`Method: ${escapeHtml(info.method)}`);
    if (info.solid) parts.push("Solid");
    parts.push(`${fileCount} file${fileCount !== 1 ? "s" : ""}${folderCount > 0 ? `, ${folderCount} folder${folderCount !== 1 ? "s" : ""}` : ""}`);
    parts.push(`${formatSize(totalSize)} \u2192 ${formatSize(totalPacked)}`);
    summary.innerHTML = parts.join(" &nbsp;\u00b7&nbsp; ");
  }

  const tbody = document.getElementById("browse-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (info.entries.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "browse-empty";
    td.textContent = "Archive is empty.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const entry of info.entries) {
    const tr = document.createElement("tr");
    if (entry.isFolder) tr.className = "is-folder";

    const tdName = document.createElement("td");
    tdName.textContent = entry.path;
    tdName.title = entry.path;

    const tdSize = document.createElement("td");
    tdSize.className = "size-col";
    tdSize.textContent = entry.isFolder ? "\u2014" : formatSize(entry.size);

    const tdPacked = document.createElement("td");
    tdPacked.className = "size-col";
    tdPacked.textContent = entry.isFolder ? "\u2014" : formatSize(entry.packedSize);

    const tdModified = document.createElement("td");
    tdModified.textContent = entry.modified;

    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdPacked);
    tr.appendChild(tdModified);
    tbody.appendChild(tr);
  }
}

async function previewCommand() {
  try {
    const args = buildArgs();
    const sanitized = args.map(arg => {
      if (arg.startsWith("-p")) return "-p***";
      return arg;
    });
    await message(`7z ${sanitized.join(" ")}`, { title: "Command preview" });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    await message(messageText, { title: "Missing info" });
  }
}

async function notify(title: string, body: string) {
  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === "granted";
  }
  if (granted) {
    sendNotification({ title, body });
  }
}

async function checkUpdates() {
  try {
    setStatus("Checking updates");
    const update = await check();
    if (!update) {
      devLog("No updates available.");
      await message("You are running the latest version.", { title: "No updates" });
      setStatus("Idle");
      return;
    }
    log(`Update available: ${update.version}`);
    const confirmed = await message(
      `Version ${update.version} is available. Download and install now?\n\nThe app will restart after installation.`,
      { title: "Update available", kind: "info", okLabel: "Install" }
    );
    if (!confirmed) {
      setStatus("Idle");
      return;
    }
    setStatus("Downloading update");
    await update.downloadAndInstall();
    log("Update installed. Relaunching...");
    await relaunch();
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    log(`Updater error: ${messageText}`);
    setStatus("Idle");
  }
}

async function autoCheckUpdates() {
  try {
    const update = await check();
    if (!update) {
      devLog("Auto-update check: no updates available.");
      return;
    }
    log(`Update available: ${update.version}`);
    await notify("Zinnia Update Available", `Version ${update.version} is available. Downloading in the background...`);
    setStatus("Downloading update");
    await update.downloadAndInstall();
    setStatus("Update ready");
    log(`Update ${update.version} downloaded and ready to install.`);
    const restart = await ask(
      `Version ${update.version} has been downloaded and is ready to install.\n\nRestart now to apply the update?`,
      { title: "Update ready", kind: "info", okLabel: "Restart now", cancelLabel: "Later" }
    );
    if (restart) {
      await relaunch();
    } else {
      await notify("Zinnia", "Update will be applied next time you restart.");
      setStatus("Idle");
    }
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    devLog(`Auto-update error: ${messageText}`);
  }
}

async function chooseOutput() {
  const format = $<HTMLSelectElement>("format").value;
  const output = await save({
    title: "Choose output archive",
    defaultPath: `zinnia.${format}`
  });
  if (output) {
    $<HTMLInputElement>("output-path").value = output;
  }
}

async function chooseExtract() {
  const output = await open({
    title: "Choose destination folder",
    directory: true
  });
  if (output && typeof output === "string") {
    $<HTMLInputElement>("extract-path").value = output;
  }
}

async function addFiles() {
  const selection = await open({
    title: "Add files",
    multiple: true
  });
  if (!selection) return;
  const newPaths = Array.isArray(selection) ? selection : [selection];
  for (const path of newPaths) {
    if (!inputs.includes(path)) {
      inputs.push(path);
    }
  }
  renderInputs();
}

async function addFolder() {
  const selection = await open({
    title: "Add folder",
    directory: true
  });
  if (selection && typeof selection === "string") {
    if (!inputs.includes(selection)) {
      inputs.push(selection);
    }
    renderInputs();
  }
}

function setOsIntegrationToggle(enabled: boolean) {
  osIntegrationEnabled = enabled;
  const input = document.getElementById("s-os-integration") as HTMLInputElement | null;
  if (input) input.checked = enabled;
}

async function enableOsIntegration(): Promise<boolean> {
  try {
    if (platformName === "windows") {
      await invoke("register_windows_context_menu");
    } else if (platformName === "linux") {
      await invoke("register_linux_desktop_integration");
    } else {
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`OS integration registration failed: ${msg}`);
    return false;
  }
}

async function disableOsIntegration(): Promise<boolean> {
  try {
    if (platformName === "windows") {
      await invoke("unregister_windows_context_menu");
    } else if (platformName === "linux") {
      await invoke("unregister_linux_desktop_integration");
    } else {
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`OS integration removal failed: ${msg}`);
    return false;
  }
}

async function toggleOsIntegration() {
  if (!appIsPackaged) {
    log("OS integration is disabled in development builds.");
    setOsIntegrationToggle(false);
    return;
  }
  if (osIntegrationEnabled) {
    if (await disableOsIntegration()) {
      setOsIntegrationToggle(false);
      log("File manager integration disabled.");
    }
  } else {
    if (await enableOsIntegration()) {
      setOsIntegrationToggle(true);
      log("File manager integration enabled.");
    }
  }
}

async function probeOsIntegrationStatus(): Promise<boolean> {
  try {
    if (platformName === "windows") {
      return await invoke<boolean>("get_windows_context_menu_status");
    } else if (platformName === "linux") {
      return await invoke<boolean>("get_linux_desktop_integration_status");
    }
  } catch {
  }
  return false;
}

function setMode(mode: "add" | "extract" | "browse") {
  appEl.dataset.mode = mode;
  document.querySelectorAll("[data-mode-btn]").forEach((btn) => {
    const el = btn as HTMLButtonElement;
    el.classList.toggle("is-active", el.dataset.modeBtn === mode);
  });
  renderInputs();
}

function updateCompressionOptionsForFormat(format: string) {
  const methodSelect = $<HTMLSelectElement>("method");
  const dictSelect = $<HTMLSelectElement>("dict");
  const wordSizeSelect = $<HTMLSelectElement>("word-size");
  const solidSelect = $<HTMLSelectElement>("solid");
  const levelSelect = $<HTMLSelectElement>("level");

  const currentMethod = methodSelect.value;
  const currentDict = dictSelect.value;
  const currentWordSize = wordSizeSelect.value;
  const currentSolid = solidSelect.value;
  const currentLevel = levelSelect.value;

  const validMethods: Record<string, string[]> = {
    "7z": ["lzma2", "lzma", "ppmd", "bzip2"],
    "zip": ["deflate", "bzip2", "lzma"],
    "tar": [],
    "gzip": [],
    "bzip2": [],
    "xz": []
  };

  const methods = validMethods[format] || [];

  methodSelect.innerHTML = "";
  if (methods.length > 0) {
    methods.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m === "lzma2" ? "LZMA2" :
                        m === "lzma" ? "LZMA" :
                        m === "ppmd" ? "PPMd" :
                        m === "bzip2" ? "BZip2" :
                        m === "deflate" ? "Deflate" :
                        m === "zstd" ? "Zstandard" : m;
      methodSelect.appendChild(opt);
    });
    if (methods.includes(currentMethod)) {
      methodSelect.value = currentMethod;
    }
    methodSelect.disabled = false;
  } else {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "N/A";
    methodSelect.appendChild(opt);
    methodSelect.disabled = true;
  }

  if (currentDict) {
    dictSelect.value = currentDict;
  }

  if (currentWordSize) {
    wordSizeSelect.value = currentWordSize;
  }

  if (currentSolid) {
    solidSelect.value = currentSolid;
  }

  if (format === "tar" || format === "gzip" || format === "bzip2" || format === "xz") {
    if (currentLevel === "0") {
      levelSelect.value = "5";
    }
  }
}

function applyPreset(name: string) {
  if (name === "custom") return;
  const preset = PRESETS[name];
  if (!preset) return;

  $<HTMLSelectElement>("format").value = preset.format;
  updateCompressionOptionsForFormat(preset.format);
  $<HTMLSelectElement>("level").value = preset.level;
  $<HTMLSelectElement>("method").value = preset.method;
  $<HTMLSelectElement>("dict").value = preset.dict;
  $<HTMLSelectElement>("word-size").value = preset.wordSize;
  $<HTMLSelectElement>("solid").value = preset.solid;
}

function detectPreset(): string {
  const format = $<HTMLSelectElement>("format").value;
  const level = $<HTMLSelectElement>("level").value;
  const method = $<HTMLSelectElement>("method").value;
  const dict = $<HTMLSelectElement>("dict").value;
  const wordSize = $<HTMLSelectElement>("word-size").value;
  const solid = $<HTMLSelectElement>("solid").value;

  for (const [name, p] of Object.entries(PRESETS)) {
    if (p.format === format && p.level === level && p.method === method &&
        p.dict === dict && p.wordSize === wordSize && p.solid === solid) {
      return name;
    }
  }
  return "custom";
}

function onCompressionOptionChange() {
  $<HTMLSelectElement>("preset").value = detectPreset();
}

interface LicenseEntry {
  licenses: string;
  repository?: string;
  licenseUrl?: string;
  parents?: string;
}

function openLicensesModal() {
  $("licenses-overlay").hidden = false;
  renderLicenses();
}

function closeLicensesModal() {
  $("licenses-overlay").hidden = true;
}

function safeHref(url: string): string {
  return SAFE_URL_PATTERN.test(url) ? escapeHtml(url) : "#";
}

async function renderLicenses() {
  const container = $("licenses-list");
  container.textContent = "Loading\u2026";

  try {
    const resp = await fetch("/licenses.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as Record<string, LicenseEntry>;
    container.innerHTML = "";

    const twemojiCard = document.createElement("details");
    twemojiCard.className = "license-card";
    twemojiCard.innerHTML =
      `<summary class="license-card__header">` +
      `<strong>Twemoji</strong><span class="license-card__tag">CC-BY-4.0 / MIT</span>` +
      `</summary>` +
      `<div class="license-card__body">` +
      `<p>Emoji graphics by <a href="https://github.com/jdecked/twemoji" target="_blank" rel="noopener">jdecked/twemoji</a>, ` +
      `licensed under <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC-BY 4.0</a>.</p>` +
      `<p>Code licensed under <a href="https://opensource.org/licenses/MIT" target="_blank" rel="noopener">MIT</a>.</p>` +
      `<p>Copyright 2019 Twitter, Inc and other contributors.<br/>Copyright 2024 jdecked and other contributors.</p>` +
      `</div>`;
    container.appendChild(twemojiCard);

    const sevenZipCard = document.createElement("details");
    sevenZipCard.className = "license-card";
    sevenZipCard.innerHTML =
      `<summary class="license-card__header">` +
      `<strong>7-Zip</strong><span class="license-card__tag">LGPL-2.1 / BSD-3-Clause</span>` +
      `</summary>` +
      `<div class="license-card__body">` +
      `<p><a href="https://7-zip.org/" target="_blank" rel="noopener">7-Zip</a> by Igor Pavlov.</p>` +
      `<p>Most of the code is under the GNU LGPL license. Some parts are under the BSD 3-clause license. ` +
      `There is also unRAR license restriction for some parts of the code.</p>` +
      `</div>`;
    container.appendChild(sevenZipCard);

    for (const [key, entry] of Object.entries(data)) {
      const card = document.createElement("details");
      card.className = "license-card";

      const href = entry.repository ? safeHref(entry.repository) : "";
      const repoLink = href && href !== "#"
        ? `<a href="${href}" target="_blank" rel="noopener">${escapeHtml(entry.repository!)}</a>`
        : "N/A";

      card.innerHTML =
        `<summary class="license-card__header">` +
        `<strong>${escapeHtml(key)}</strong><span class="license-card__tag">${escapeHtml(entry.licenses)}</span>` +
        `</summary>` +
        `<div class="license-card__body">${repoLink}</div>`;
      container.appendChild(card);
    }
  } catch {
    container.textContent = "Failed to load licenses.";
  }
}

function wireEvents() {
  $("add-files").addEventListener("click", addFiles);
  $("add-folder").addEventListener("click", addFolder);
  $("clear-inputs").addEventListener("click", () => {
    inputs.length = 0;
    renderInputs();
    const bc = document.getElementById("browse-contents");
    if (bc) bc.hidden = true;
  });
  $("choose-output").addEventListener("click", chooseOutput);
  $("choose-extract").addEventListener("click", chooseExtract);
  $("run-action").addEventListener("click", runAction);
  $("cancel-action").addEventListener("click", cancelAction);
  $("show-command").addEventListener("click", previewCommand);
  $("clear-log").addEventListener("click", () => (logEl.textContent = ""));

  $("extract-run").addEventListener("click", runAction);
  $("extract-cancel").addEventListener("click", cancelAction);
  $("extract-preview").addEventListener("click", previewCommand);
  $("test-integrity").addEventListener("click", testArchive);

  $("browse-list").addEventListener("click", browseArchive);
  $("browse-test").addEventListener("click", testArchive);
  $("browse-extract").addEventListener("click", () => setMode("extract"));

  $("toggle-browse-password").addEventListener("click", () => {
    const input = $<HTMLInputElement>("browse-password");
    const btn = $<HTMLButtonElement>("toggle-browse-password");
    if (input.type === "password") {
      input.type = "text";
      btn.textContent = "Hide";
    } else {
      input.type = "password";
      btn.textContent = "Show";
    }
  });

  $<HTMLSelectElement>("preset").addEventListener("change", () => {
    applyPreset($<HTMLSelectElement>("preset").value);
  });

  $<HTMLSelectElement>("format").addEventListener("change", () => {
    updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
    onCompressionOptionChange();
  });

  for (const id of ["level", "method", "dict", "word-size", "solid"]) {
    $(id).addEventListener("change", onCompressionOptionChange);
  }

  $("toggle-password").addEventListener("click", () => {
    const input = $<HTMLInputElement>("password");
    const btn = $<HTMLButtonElement>("toggle-password");
    if (input.type === "password") {
      input.type = "text";
      btn.textContent = "Hide";
    } else {
      input.type = "password";
      btn.textContent = "Show";
    }
  });

  $("toggle-extract-password").addEventListener("click", () => {
    const input = $<HTMLInputElement>("extract-password");
    const btn = $<HTMLButtonElement>("toggle-extract-password");
    if (input.type === "password") {
      input.type = "text";
      btn.textContent = "Hide";
    } else {
      input.type = "password";
      btn.textContent = "Show";
    }
  });

  $("toggle-activity").addEventListener("click", toggleActivity);

  $("open-settings").addEventListener("click", openSettingsModal);
  $("close-settings").addEventListener("click", closeSettingsModal);
  $("cancel-settings").addEventListener("click", closeSettingsModal);
  $("settings-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSettingsModal();
  });
  $("save-settings").addEventListener("click", async () => {
    currentSettings = readSettingsModal();
    applySettingsToForm();
    try {
      await saveSettings(currentSettings);
      log("Settings saved successfully.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to save settings: ${msg}`);
    }
    closeSettingsModal();
  });

  document.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("is-active"));
      document.querySelectorAll(".settings-panel").forEach(p => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      const panel = document.querySelector(`[data-panel="${tab.dataset.tab}"]`);
      if (panel) panel.classList.add("is-active");
    });
  });

  $("check-updates").addEventListener("click", checkUpdates);
  $("s-os-integration").addEventListener("change", toggleOsIntegration);
  $("show-licenses").addEventListener("click", openLicensesModal);
  $("about-show-licenses").addEventListener("click", openLicensesModal);

  $("close-licenses").addEventListener("click", closeLicensesModal);
  $("licenses-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeLicensesModal();
  });

  document.querySelectorAll("[data-mode-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const m = (btn as HTMLButtonElement).dataset.modeBtn;
      if (m === "extract") setMode("extract");
      else if (m === "browse") setMode("browse");
      else setMode("add");
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("settings-overlay").hidden) { closeSettingsModal(); return; }
      if (!$("licenses-overlay").hidden) { closeLicensesModal(); return; }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (getMode() === "browse") browseArchive();
      else runAction();
    }
  });
}

async function init() {
  const cpuCount = await invoke<number>("get_cpu_count");
  SETTING_DEFAULTS.threads = cpuCount;

  currentSettings = await loadSettings();
  applySettingsToForm();

  renderInputs();
  wireEvents();

  updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);

  const version = `v${await getVersion()}`;
  const platform = await invoke<string>("get_platform_info");
  platformName = platform;
  appIsPackaged = await invoke<boolean>("is_packaged");
  const platformDisplay = platform === "windows" ? "Windows" :
                          platform === "macos" ? "macOS" :
                          platform === "linux" ? "Linux" : platform;
  versionLabel.textContent = version;
  platformLabel.textContent = platformDisplay;
  $("s-version-label").textContent = version;
  $("s-platform-label").textContent = platformDisplay;

  const flatpak = await invoke<boolean>("is_flatpak");
  if (flatpak) {
    document.body.classList.add("platform-flatpak");
  }

  const osRow = document.getElementById("os-integration-row");
  const hasOsIntegration = platform === "windows" || (platform === "linux" && !flatpak);
  if (osRow) {
    osRow.style.display = hasOsIntegration ? "" : "none";
  }

  if (platform === "windows") {
    document.body.classList.add("platform-windows");
    const title = document.getElementById("os-integration-title");
    const desc = document.getElementById("os-integration-desc");
    if (title) title.textContent = "Windows Explorer integration";
    if (desc) desc.textContent = "Add \"Compress with Zinnia\" and \"Extract with Zinnia\" to right-click menus.";
  } else if (platform === "linux") {
    document.body.classList.add("platform-linux");
    const title = document.getElementById("os-integration-title");
    const desc = document.getElementById("os-integration-desc");
    if (title) title.textContent = "File manager integration";
    if (desc) desc.textContent = "Register Zinnia as a handler for archive files in your desktop environment.";
  }

  if (hasOsIntegration && appIsPackaged) {
    const isEnabled = await probeOsIntegrationStatus();
    setOsIntegrationToggle(isEnabled);

    if (!isEnabled) {
      const raw = await invoke<string>("load_settings");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed._integrationAutoEnabled === undefined) {
        if (await enableOsIntegration()) {
          setOsIntegrationToggle(true);
          devLog("File manager integration auto-enabled on first run.");
        }
        parsed._integrationAutoEnabled = true;
        await invoke("save_settings", { json: JSON.stringify(parsed) });
      }
    }
  } else if (!appIsPackaged) {
    const input = document.getElementById("s-os-integration") as HTMLInputElement | null;
    if (input) {
      input.disabled = true;
    }
    const desc = document.getElementById("os-integration-desc");
    if (desc) desc.textContent = "Disabled in development builds. Only packaged installations can register.";
  }

  await listen<{ paths: string[]; mode: string }>("open-paths", (event) => {
    const { paths, mode } = event.payload;
    if (paths.length) {
      if (mode === "extract") {
        setMode("extract");
        inputs.length = 0;
      } else if (paths.every(p => isArchiveFile(p))) {
        setMode("browse");
        inputs.length = 0;
      }
      for (const path of paths) {
        if (!inputs.includes(path)) {
          inputs.push(path);
        }
      }
      renderInputs();
      devLog(`Received ${paths.length} path(s) from Explorer.`);
      if (getMode() === "browse") browseArchive();
    }
  });

  const initialMode = await invoke<string>("get_initial_mode");
  const initialPaths = await invoke<string[]>("get_initial_paths");
  if (initialPaths.length) {
    for (const path of initialPaths) {
      if (!inputs.includes(path)) {
        inputs.push(path);
      }
    }
    if (initialMode === "extract") {
      setMode("extract");
    } else if (initialPaths.every(p => isArchiveFile(p))) {
      setMode("browse");
    }
    renderInputs();
    devLog(`Loaded ${initialPaths.length} path(s) from launch args.`);
    if (getMode() === "browse") browseArchive();
  }

  if (currentSettings.autoCheckUpdates && !flatpak) {
    autoCheckUpdates();
  }

  const appWindow = getCurrentWebviewWindow();
  await appWindow.onDragDropEvent((event) => {
    if (event.payload.type === "enter" || event.payload.type === "over") {
      inputList.classList.add("list--dragover");
    } else if (event.payload.type === "leave") {
      inputList.classList.remove("list--dragover");
    } else if (event.payload.type === "drop") {
      inputList.classList.remove("list--dragover");
      const paths = event.payload.paths;
      if (paths.length) {
        for (const path of paths) {
          if (!inputs.includes(path)) {
            inputs.push(path);
          }
        }
        renderInputs();
        if (getMode() === "browse" && inputs.length > 0 && isArchiveFile(inputs[0])) {
          browseArchive();
        }
      }
    }
  });
}

init().catch((err) => {
  document.body.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
