import { $ } from "./utils";
import { getCompressionSecuritySupport } from "./compression-security";
import { state } from "./state";
import type { CustomPreset } from "./settings-model";

export interface PresetConfig {
  format: string;
  level: string;
  method: string;
  dict: string;
  wordSize: string;
  solid: string;
}

const CUSTOM_PRESET_PREFIX = "custom:";

function currentConfig(): PresetConfig {
  return {
    format: $<HTMLSelectElement>("format").value,
    level: $<HTMLSelectElement>("level").value,
    method: $<HTMLSelectElement>("method").value,
    dict: $<HTMLSelectElement>("dict").value,
    wordSize: $<HTMLSelectElement>("word-size").value,
    solid: $<HTMLSelectElement>("solid").value,
  };
}

function getCustomPreset(name: string): CustomPreset | undefined {
  return state.currentSettings.customPresets.find((p) => p.name === name);
}

export const PRESETS: Record<string, PresetConfig> = {
  store: {
    format: "zip",
    level: "0",
    method: "deflate",
    dict: "16m",
    wordSize: "16",
    solid: "off",
  },
  quick: {
    format: "zip",
    level: "1",
    method: "deflate",
    dict: "16m",
    wordSize: "32",
    solid: "off",
  },
  balanced: {
    format: "7z",
    level: "5",
    method: "lzma2",
    dict: "64m",
    wordSize: "64",
    solid: "4g",
  },
  high: {
    format: "7z",
    level: "7",
    method: "lzma2",
    dict: "128m",
    wordSize: "64",
    solid: "16g",
  },
  ultra: {
    format: "7z",
    level: "9",
    method: "lzma2",
    dict: "512m",
    wordSize: "128",
    solid: "solid",
  },
};

const PASSWORD_PLACEHOLDER_DEFAULT = "Leave blank for none";
const PASSWORD_PLACEHOLDER_UNSUPPORTED = "Not supported for this format";

function updateSecurityControlsForFormat(format: string) {
  const support = getCompressionSecuritySupport(format);
  const passwordInput = $<HTMLInputElement>("password");
  const passwordToggle = $<HTMLButtonElement>("toggle-password");
  const encryptHeadersCheckbox = $<HTMLInputElement>("encrypt-headers");

  passwordInput.disabled = !support.password;
  passwordToggle.disabled = !support.password;

  if (support.password) {
    passwordInput.placeholder = PASSWORD_PLACEHOLDER_DEFAULT;
    passwordInput.title = "";
  } else {
    passwordInput.placeholder = PASSWORD_PLACEHOLDER_UNSUPPORTED;
    passwordInput.title = `${format.toUpperCase()} archives do not support password protection in this app.`;
    passwordInput.type = "password";
    passwordToggle.textContent = "Show";
  }

  if (!support.encryptHeaders) {
    encryptHeadersCheckbox.checked = false;
  }
  encryptHeadersCheckbox.disabled = !support.encryptHeaders;
  const encryptHeadersLabel = encryptHeadersCheckbox.closest("label");
  if (encryptHeadersLabel) {
    encryptHeadersLabel.title = support.encryptHeaders
      ? ""
      : `${format.toUpperCase()} archives do not support file-name encryption.`;
  }
}

export function updateCompressionOptionsForFormat(format: string) {
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
    zip: ["deflate", "bzip2", "lzma"],
    tar: [],
    gzip: [],
    bzip2: [],
    xz: [],
  };

  const methods = validMethods[format] || [];

  methodSelect.innerHTML = "";
  if (methods.length > 0) {
    methods.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent =
        m === "lzma2"
          ? "LZMA2"
          : m === "lzma"
            ? "LZMA"
            : m === "ppmd"
              ? "PPMd"
              : m === "bzip2"
                ? "BZip2"
                : m === "deflate"
                  ? "Deflate"
                  : m === "zstd"
                    ? "Zstandard"
                    : m;
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

  // Solid mode is only supported for 7z archives
  const solidSupported = format === "7z";
  solidSelect.disabled = !solidSupported;
  if (!solidSupported) {
    solidSelect.value = "off";
  }

  if (
    format === "tar" ||
    format === "gzip" ||
    format === "bzip2" ||
    format === "xz"
  ) {
    if (currentLevel === "0") {
      levelSelect.value = "5";
    }
  }

  updateSecurityControlsForFormat(format);
}

export function applyPreset(name: string) {
  if (name === "custom") return;

  let preset: PresetConfig | undefined = PRESETS[name];
  if (!preset && name.startsWith(CUSTOM_PRESET_PREFIX)) {
    preset = getCustomPreset(name.slice(CUSTOM_PRESET_PREFIX.length));
  }
  if (!preset) return;

  $<HTMLSelectElement>("format").value = preset.format;
  updateCompressionOptionsForFormat(preset.format);
  $<HTMLSelectElement>("level").value = preset.level;
  $<HTMLSelectElement>("method").value = preset.method;
  $<HTMLSelectElement>("dict").value = preset.dict;
  $<HTMLSelectElement>("word-size").value = preset.wordSize;
  $<HTMLSelectElement>("solid").value = preset.solid;
}

function configsMatch(a: PresetConfig, b: PresetConfig): boolean {
  return (
    a.format === b.format &&
    a.level === b.level &&
    a.method === b.method &&
    a.dict === b.dict &&
    a.wordSize === b.wordSize &&
    a.solid === b.solid
  );
}

export function detectPreset(): string {
  const config = currentConfig();

  for (const [name, p] of Object.entries(PRESETS)) {
    if (configsMatch(p, config)) return name;
  }
  for (const p of state.currentSettings.customPresets) {
    if (configsMatch(p, config)) return `${CUSTOM_PRESET_PREFIX}${p.name}`;
  }
  return "custom";
}

// Add or replace a named custom preset from the current compression options.
export function saveCustomPreset(name: string): CustomPreset {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Preset name cannot be empty.");
  if (trimmed in PRESETS) {
    throw new Error(`"${trimmed}" is a built-in preset name. Choose another.`);
  }

  const preset: CustomPreset = { name: trimmed, ...currentConfig() };
  const existing = state.currentSettings.customPresets.filter(
    (p) => p.name !== trimmed,
  );
  state.currentSettings.customPresets = [...existing, preset];
  return preset;
}

export function deleteCustomPreset(name: string): void {
  state.currentSettings.customPresets =
    state.currentSettings.customPresets.filter((p) => p.name !== name);
}

export function refreshPresetDropdown(selected?: string): void {
  const select = $<HTMLSelectElement>("preset");
  const current = selected ?? select.value;

  for (const opt of [...select.options]) {
    if (opt.value.startsWith(CUSTOM_PRESET_PREFIX)) opt.remove();
  }

  const customOptionGroup = state.currentSettings.customPresets;
  const customAnchor = [...select.options].find((o) => o.value === "custom");
  for (const preset of customOptionGroup) {
    const opt = document.createElement("option");
    opt.value = `${CUSTOM_PRESET_PREFIX}${preset.name}`;
    opt.textContent = preset.name;
    select.insertBefore(opt, customAnchor ?? null);
  }

  if ([...select.options].some((o) => o.value === current)) {
    select.value = current;
  }
}

export function onCompressionOptionChange() {
  $<HTMLSelectElement>("preset").value = detectPreset();
}
