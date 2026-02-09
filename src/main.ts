import { open, save, message } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";




function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
          .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el as T;
}



interface UserSettings {
  format: string;
  level: string;
  method: string;
  dict: string;
  threads: number;
  pathMode: string;
}

const SETTING_DEFAULTS: UserSettings = {
  format: "7z",
  level: "5",
  method: "lzma2",
  dict: "256m",
  threads: 8,
  pathMode: "relative",
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
  $<HTMLInputElement>("threads").value = String(currentSettings.threads);
  $<HTMLSelectElement>("path-mode").value = currentSettings.pathMode;
}


function populateSettingsModal() {
  $<HTMLSelectElement>("s-format").value = currentSettings.format;
  $<HTMLSelectElement>("s-level").value = currentSettings.level;
  $<HTMLSelectElement>("s-method").value = currentSettings.method;
  $<HTMLSelectElement>("s-dict").value = currentSettings.dict;
  $<HTMLInputElement>("s-threads").value = String(currentSettings.threads);
  $<HTMLSelectElement>("s-path-mode").value = currentSettings.pathMode;
}


function readSettingsModal(): UserSettings {
  return {
    format: $<HTMLSelectElement>("s-format").value,
    level: $<HTMLSelectElement>("s-level").value,
    method: $<HTMLSelectElement>("s-method").value,
    dict: $<HTMLSelectElement>("s-dict").value,
    threads: Number($<HTMLInputElement>("s-threads").value) || SETTING_DEFAULTS.threads,
    pathMode: $<HTMLSelectElement>("s-path-mode").value,
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
const versionLabel = $("version-label");
const platformLabel = $("platform-label");
const appEl = $("app");
const gridEl = document.querySelector(".grid")!;

const inputs: string[] = [];

function log(line: string) {
  const stamp = new Date().toLocaleTimeString();
  logEl.textContent += `[${stamp}] ${line}\n`;
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

function setStatus(text: string) {
  statusEl.textContent = text;
}

function renderInputs() {
  inputList.innerHTML = "";
  if (inputs.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "Drop files here or use the buttons above.";
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

function getMode() {
  return appEl.dataset.mode === "extract" ? "extract" : "add";
}

function buildArgs() {
  const mode = getMode();
  const extraArgs = splitArgs($<HTMLInputElement>("extra-args").value.trim());

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
  const threads = $<HTMLInputElement>("threads").value;
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
  const runBtn = $<HTMLButtonElement>("run-action");
  try {
    const args = buildArgs();
    devLog(`7z ${args.join(" ")}`);
    setStatus("Running");
    runBtn.disabled = true;
    const result = await invoke<{ stdout: string; stderr: string; code: number }>("run_7z", { args });
    if (result.stdout) log(result.stdout.trim());
    if (result.stderr) log(result.stderr.trim());
    devLog(`Exit code: ${result.code}`);
    setStatus("Done");
    setTimeout(() => setStatus("Idle"), 2000);
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    log(`Error: ${messageText}`);
    setStatus("Error");
    setTimeout(() => setStatus("Idle"), 3000);
  } finally {
    runBtn.disabled = false;
  }
}

async function previewCommand() {
  try {
    const args = buildArgs();
    await message(`7z ${args.join(" ")}`, { title: "Command preview" });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    await message(messageText, { title: "Missing info" });
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
      { title: "Update available", kind: "info", okLabel: "Install", cancelLabel: "Not now" }
    );
    if (!confirmed) {
      setStatus("Idle");
      return;
    }
    await update.downloadAndInstall();
    log("Update installed. Relaunching...");
    await relaunch();
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    log(`Updater error: ${messageText}`);
    setStatus("Idle");
  }
}

async function chooseOutput() {
  const format = $<HTMLSelectElement>("format").value;
  const output = await save({
    title: "Choose output archive",
    defaultPath: `chrysanthemum.${format}`
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

async function registerExplorer() {
  try {
    await invoke("register_windows_context_menu");
    log("Explorer integration enabled.");
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    log(`Explorer integration failed: ${messageText}`);
  }
}

async function unregisterExplorer() {
  try {
    await invoke("unregister_windows_context_menu");
    log("Explorer integration disabled.");
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    log(`Explorer integration removal failed: ${messageText}`);
  }
}

function setMode(mode: "add" | "extract") {
  appEl.dataset.mode = mode;
  document.querySelectorAll("[data-mode-btn]").forEach((btn) => {
    const el = btn as HTMLButtonElement;
    el.classList.toggle("is-active", el.dataset.modeBtn === mode);
  });
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

async function renderLicenses() {
  const container = $("licenses-list");
  container.textContent = "Loading\u2026";

  try {
    const resp = await fetch("/licenses.json");
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

      const safeRepo = entry.repository ? escapeHtml(entry.repository) : "";
      const repoLink = safeRepo
        ? `<a href="${safeRepo}" target="_blank" rel="noopener">${safeRepo}</a>`
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
  $("show-command").addEventListener("click", previewCommand);
  $("clear-log").addEventListener("click", () => (logEl.textContent = ""));

  
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
      devLog("Settings saved.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to save settings: ${msg}`);
    }
    closeSettingsModal();
  });

  
  $("check-updates").addEventListener("click", checkUpdates);
  $("register-explorer").addEventListener("click", registerExplorer);
  $("unregister-explorer").addEventListener("click", unregisterExplorer);
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
  
  currentSettings = await loadSettings();
  applySettingsToForm();

  renderInputs();
  wireEvents();
  const version = `v${await getVersion()}`;
  const platform = (navigator as any).userAgentData?.platform ?? navigator.platform;
  versionLabel.textContent = version;
  platformLabel.textContent = platform;
  $("s-version-label").textContent = version;
  $("s-platform-label").textContent = platform;

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

init();
