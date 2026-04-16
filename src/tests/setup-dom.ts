/**
 * Shared DOM setup for vitest + jsdom.
 * Creates all DOM elements that source modules expect at import time
 * and mocks Tauri APIs so modules can be imported without the Tauri runtime.
 */
import { vi } from "vitest";

// ── Tauri API mocks ──
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(""),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: vi.fn().mockResolvedValue(undefined),
  confirm: vi.fn().mockResolvedValue(false),
  ask: vi.fn().mockResolvedValue(false),
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.0.0-test"),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn().mockReturnValue({
    onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
  }),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(false),
  requestPermission: vi.fn().mockResolvedValue("denied"),
  sendNotification: vi.fn(),
}));

// ── DOM elements ──

function addEl(
  tag: string,
  id: string,
  attrs?: Record<string, string>,
): HTMLElement {
  const el = document.createElement(tag);
  el.id = id;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  }
  document.body.appendChild(el);
  return el;
}

function addSelect(id: string, options: string[] = []): HTMLSelectElement {
  const sel = addEl("select", id) as HTMLSelectElement;
  for (const val of options) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = val;
    sel.appendChild(opt);
  }
  return sel;
}

// Core layout elements
addEl("div", "app");
addEl("div", "input-list");
addEl("div", "log");
addEl("div", "status");
addEl("div", "progress");
addEl("div", "version-label");
addEl("div", "platform-label");

const grid = document.createElement("div");
grid.className = "grid";
document.body.appendChild(grid);

// Action buttons
addEl("button", "run-action");
addEl("button", "cancel-action");
addEl("button", "extract-run");
addEl("button", "extract-cancel");
addEl("button", "show-command");
addEl("button", "extract-preview");
addEl("button", "test-integrity");
addEl("button", "clear-log");
addEl("button", "toggle-activity");
const workspaceBasic = addEl("button", "workspace-mode-basic");
workspaceBasic.setAttribute("data-workspace-mode-btn", "basic");
const workspacePower = addEl("button", "workspace-mode-power");
workspacePower.setAttribute("data-workspace-mode-btn", "power");
addEl("button", "toggle-density");
addEl("button", "add-files");
addEl("button", "add-folder");
addEl("button", "clear-inputs");
addEl("button", "choose-output");
addEl("button", "choose-extract");
addEl("button", "open-settings");

// Browse buttons
addEl("button", "browse-list");
addEl("button", "browse-test");
addEl("button", "browse-extract");
addEl("button", "browse-selective");
for (const [quickActionId, quickAction] of [
  ["quick-add-balanced", "add-run-balanced"],
  ["quick-add-ultra", "add-run-ultra"],
  ["quick-add-encrypt-run", "add-encrypt-run"],
  ["quick-add-preview", "add-preview"],
  ["quick-add-repeat", "add-repeat"],
  ["quick-extract-now", "extract-now"],
  ["quick-extract-test-then-extract", "extract-test-then-extract"],
  ["quick-extract-selective", "extract-selective"],
  ["quick-extract-preview", "extract-preview"],
  ["quick-extract-repeat", "extract-repeat"],
  ["quick-browse-list", "browse-list"],
  ["quick-browse-test", "browse-test"],
  ["quick-browse-selective", "browse-selective"],
  ["quick-browse-switch-extract", "browse-switch-extract"],
  ["quick-browse-repeat", "browse-repeat"],
] as const) {
  const btn = addEl("button", quickActionId);
  btn.setAttribute("data-quick-action-btn", "true");
  btn.setAttribute("data-quick-action", quickAction);
}
const quickFeedback = addEl("div", "quick-action-feedback");
quickFeedback.hidden = true;

// Selective extraction
addEl("button", "selective-select-all");
addEl("button", "selective-clear");
addEl("button", "selective-cancel");
addEl("button", "selective-confirm");
addEl("button", "selective-browse-dest");
addEl("button", "close-selective");
addEl("div", "selective-overlay");

// Browse password
const browsePassField = addEl("div", "browse-password-field");
browsePassField.hidden = true;
addEl("input", "browse-password");
addEl("button", "toggle-browse-password");

// Browse contents
addEl("div", "browse-contents");

// Mode buttons
for (const mode of ["add", "extract", "browse"]) {
  const btn = addEl("button", `mode-${mode}`);
  btn.setAttribute("data-mode-btn", mode);
}

// Compression form selects
const LEVEL_OPTIONS = ["0", "1", "3", "5", "7", "9"];
const METHOD_OPTIONS = ["lzma2", "lzma", "ppmd", "bzip2", "deflate"];
const DICT_OPTIONS = ["", "16m", "32m", "64m", "128m", "256m", "512m"];
const WORD_SIZE_OPTIONS = ["", "16", "32", "64", "128", "256"];
const SOLID_OPTIONS = ["off", "4g", "16g", "solid"];
const FORMAT_OPTIONS = ["7z", "zip", "tar", "gzip", "bzip2", "xz"];
const PATH_MODE_OPTIONS = ["relative", "absolute"];

addSelect("format", FORMAT_OPTIONS);
addSelect("level", LEVEL_OPTIONS);
addSelect("method", METHOD_OPTIONS);
addSelect("dict", DICT_OPTIONS);
addSelect("word-size", WORD_SIZE_OPTIONS);
addSelect("solid", SOLID_OPTIONS);
addSelect("path-mode", PATH_MODE_OPTIONS);
addSelect("preset", ["store", "quick", "balanced", "high", "ultra", "custom"]);

// Compression form inputs
addEl("input", "output-path");
addEl("input", "threads");
addEl("input", "password");
addEl("input", "extra-args");
const encryptHeaders = addEl("input", "encrypt-headers") as HTMLInputElement;
encryptHeaders.type = "checkbox";
const sfxInput = addEl("input", "sfx") as HTMLInputElement;
sfxInput.type = "checkbox";
const deleteAfter = addEl("input", "delete-after") as HTMLInputElement;
deleteAfter.type = "checkbox";
addEl("button", "toggle-password");

// Extract form inputs
addEl("input", "extract-path");
addEl("input", "extract-password");
addEl("input", "extract-extra-args");
addEl("button", "toggle-extract-password");

// Settings modal selects
addSelect("s-theme", ["system", "dark", "light"]);
addSelect("s-format", FORMAT_OPTIONS);
addSelect("s-level", LEVEL_OPTIONS);
addSelect("s-method", METHOD_OPTIONS);
addSelect("s-dict", DICT_OPTIONS);
addSelect("s-word-size", WORD_SIZE_OPTIONS);
addSelect("s-solid", SOLID_OPTIONS);
addSelect("s-path-mode", PATH_MODE_OPTIONS);
addSelect("s-update-channel", ["auto", "stable", "beta"]);
addSelect("s-log-verbosity", ["info", "debug"]);
addSelect("s-workspace-mode", ["basic", "power"]);
addSelect("s-ui-density", ["comfortable", "compact"]);

// Settings modal inputs
addEl("input", "s-threads");
const ssfx = addEl("input", "s-sfx") as HTMLInputElement;
ssfx.type = "checkbox";
const seh = addEl("input", "s-encrypt-headers") as HTMLInputElement;
seh.type = "checkbox";
const sda = addEl("input", "s-delete-after") as HTMLInputElement;
sda.type = "checkbox";
const sacu = addEl("input", "s-auto-check-updates") as HTMLInputElement;
sacu.type = "checkbox";
const sll = addEl("input", "s-local-logging") as HTMLInputElement;
sll.type = "checkbox";
addEl("div", "s-log-dir");
addEl("div", "settings-overlay");
addEl("button", "rerun-setup-wizard");

// Licenses modal
addEl("div", "licenses-overlay");
addEl("div", "licenses-list");

// Command preview modal
const commandPreviewOverlay = addEl("div", "command-preview-overlay");
const commandPreviewModal = document.createElement("div");
commandPreviewModal.className = "modal";
commandPreviewOverlay.appendChild(commandPreviewModal);
const commandPreviewText = document.createElement("pre");
commandPreviewText.id = "command-preview-text";
commandPreviewModal.appendChild(commandPreviewText);
const copyCommandPreviewButton = document.createElement("button");
copyCommandPreviewButton.id = "copy-command-preview";
commandPreviewModal.appendChild(copyCommandPreviewButton);
const closeCommandPreviewButton = document.createElement("button");
closeCommandPreviewButton.id = "close-command-preview";
commandPreviewModal.appendChild(closeCommandPreviewButton);
const closeCommandPreviewFooterButton = document.createElement("button");
closeCommandPreviewFooterButton.id = "close-command-preview-footer";
commandPreviewModal.appendChild(closeCommandPreviewFooterButton);

// Setup wizard modal
const setupOverlay = addEl("div", "setup-wizard-overlay");
setupOverlay.hidden = true;
const setupCard = document.createElement("div");
setupCard.className = "setup-wizard-card";
setupOverlay.appendChild(setupCard);
const setupProgress = document.createElement("div");
setupProgress.id = "setup-wizard-progress-bar";
setupCard.appendChild(setupProgress);

for (const step of ["0", "1", "2", "3", "4"]) {
  const section = document.createElement("div");
  section.className = "setup-wizard-step";
  section.dataset.step = step;
  section.hidden = step !== "0";
  setupCard.appendChild(section);
}

addEl("button", "setup-welcome-next");
addEl("button", "setup-welcome-skip");
addEl("button", "setup-workspace-back");
addEl("button", "setup-workspace-next");
addEl("button", "setup-theme-back");
addEl("button", "setup-theme-next");
addEl("button", "setup-updates-back");
addEl("button", "setup-updates-next");
addEl("button", "setup-done-btn");

const setupAutoUpdates = addEl(
  "input",
  "setup-auto-updates",
) as HTMLInputElement;
setupAutoUpdates.type = "checkbox";
addSelect("setup-update-channel", ["auto", "stable", "beta"]);

for (const mode of ["basic", "power"]) {
  const btn = addEl("button", `setup-mode-${mode}`);
  btn.className = "setup-wizard-mode-btn";
  btn.setAttribute("data-workspace-value", mode);
}
for (const theme of ["system", "light", "dark"]) {
  const btn = addEl("button", `setup-theme-${theme}`);
  btn.className = "setup-wizard-theme-btn";
  btn.setAttribute("data-theme-value", theme);
}
