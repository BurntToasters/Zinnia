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

const inputs: string[] = [];
let statusTimeout: number | undefined;
let running = false;
let explorerIntegrationEnabled = false;

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

function getMode() {
  return appEl.dataset.mode === "extract" ? "extract" : "add";
}

function buildArgs() {
  const mode = getMode();
  const extraArgs = splitArgs($<HTMLInputElement>("extra-args").value.trim());

  if (extraArgs.length > 0) {
    validateExtraArgs(extraArgs);
  }

  if (mode === "extract") {
    const archive = inputs[0];
    const dest = $<HTMLInputElement>("extract-path").value.trim();
    const password = $<HTMLInputElement>("extract-password").value.trim();

    if (!archive) {
      throw new Error("Select an archive to extract.");
    }

    if (!dest) {
      throw new Error("Choose a destination folder.");
    }

    const args = ["x", archive, `-o${dest}`, "-y"];
    if (password) {
      args.push(`-p${password}`);
    }
    args.push(...extraArgs);
    return args;
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

async function runAction() {
  if (running) return;

  try {
    const deleteAfter = $<HTMLInputElement>("delete-after").checked;

    if (deleteAfter && getMode() === "add") {
      const confirmed = await message(
        "This will permanently delete source files after compression. Continue?",
        { title: "Confirm deletion", kind: "warning", okLabel: "Delete files" }
      );
      if (!confirmed) {
        return;
      }
    }

    const args = buildArgs();
    const logSafe = args.map(a => a.startsWith("-p") ? "-p***" : a);
    devLog(`7z ${logSafe.join(" ")}`);

    running = true;
    setStatus("Running");
    runBtn.disabled = true;
    runBtn.setAttribute("aria-busy", "true");
    cancelBtn.hidden = false;

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
    running = false;
    runBtn.disabled = false;
    runBtn.removeAttribute("aria-busy");
    cancelBtn.hidden = true;
  }
}

async function cancelAction() {
  try {
    await invoke("cancel_7z");
    log("Operation cancelled by user");
    setStatus("Cancelled", 2000);
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    devLog(`Cancel error: ${messageText}`);
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

function setExplorerToggleState(enabled: boolean) {
  explorerIntegrationEnabled = enabled;
  const btn = document.getElementById("toggle-explorer") as HTMLButtonElement | null;
  if (!btn) return;
  btn.textContent = enabled
    ? "Disable Explorer integration"
    : "Enable Explorer integration";
  btn.setAttribute("aria-pressed", enabled ? "true" : "false");
}

async function toggleExplorer() {
  try {
    if (explorerIntegrationEnabled) {
      await invoke("unregister_windows_context_menu");
      setExplorerToggleState(false);
      log("Explorer integration disabled.");
    } else {
      await invoke("register_windows_context_menu");
      setExplorerToggleState(true);
      log("Explorer integration enabled.");
    }
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    log(`Explorer integration failed: ${messageText}`);
  }
}

function setMode(mode: "add" | "extract") {
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

  const supportsDict = format === "7z" || format === "xz";
  dictSelect.disabled = !supportsDict;
  if (supportsDict && currentDict) {
    dictSelect.value = currentDict;
  }

  const supportsWordSize = format === "7z";
  wordSizeSelect.disabled = !supportsWordSize;
  if (supportsWordSize && currentWordSize) {
    wordSizeSelect.value = currentWordSize;
  }

  const supportsSolid = format === "7z";
  solidSelect.disabled = !supportsSolid;
  if (supportsSolid && currentSolid) {
    solidSelect.value = currentSolid;
  }

  if (format === "tar" || format === "gzip" || format === "bzip2" || format === "xz") {
    if (currentLevel === "0") {
      levelSelect.value = "5";
    }
  }
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
  });
  $("choose-output").addEventListener("click", chooseOutput);
  $("choose-extract").addEventListener("click", chooseExtract);
  $("run-action").addEventListener("click", runAction);
  $("cancel-action").addEventListener("click", cancelAction);
  $("show-command").addEventListener("click", previewCommand);
  $("clear-log").addEventListener("click", () => (logEl.textContent = ""));

  $<HTMLSelectElement>("format").addEventListener("change", () => {
    updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
  });

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

  $("check-updates").addEventListener("click", checkUpdates);
  $("toggle-explorer").addEventListener("click", toggleExplorer);
  $("show-licenses").addEventListener("click", openLicensesModal);

  $("close-licenses").addEventListener("click", closeLicensesModal);
  $("licenses-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeLicensesModal();
  });

  document.querySelectorAll("[data-mode-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = (btn as HTMLButtonElement).dataset.modeBtn === "extract" ? "extract" : "add";
      setMode(mode);
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("settings-overlay").hidden) { closeSettingsModal(); return; }
      if (!$("licenses-overlay").hidden) { closeLicensesModal(); return; }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runAction();
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

  const isWindows = platform === "windows";
  if (isWindows) {
    document.body.classList.add("platform-windows");
    try {
      const enabled = await invoke<boolean>("get_windows_context_menu_status");
      setExplorerToggleState(enabled);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      devLog(`Explorer status probe failed: ${messageText}`);
      setExplorerToggleState(false);
    }
  }

  await listen<string[]>("open-paths", (event) => {
    const paths = event.payload || [];
    if (paths.length) {
      for (const path of paths) {
        if (!inputs.includes(path)) {
          inputs.push(path);
        }
      }
      renderInputs();
      devLog(`Received ${paths.length} path(s) from Explorer.`);
    }
  });

  const initialPaths = await invoke<string[]>("get_initial_paths");
  if (initialPaths.length) {
    for (const path of initialPaths) {
      if (!inputs.includes(path)) {
        inputs.push(path);
      }
    }
    renderInputs();
    devLog(`Loaded ${initialPaths.length} path(s) from launch args.`);
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
      }
    }
  });
}

init().catch((err) => {
  document.body.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
