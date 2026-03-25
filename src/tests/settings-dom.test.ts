import { describe, it, expect, beforeEach } from "vitest";
import {
  applyTheme,
  applySettingsToForm,
  populateSettingsModal,
  readSettingsModal,
  syncSettingsSecurityControlsForFormat,
  openSettingsModal,
  closeSettingsModal,
} from "../settings";
import { state } from "../state";
import { SETTING_DEFAULTS } from "../settings-model";

function getSelectValue(id: string): string {
  return (document.getElementById(id) as HTMLSelectElement).value;
}

function getInputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement).value;
}

function getChecked(id: string): boolean {
  return (document.getElementById(id) as HTMLInputElement).checked;
}

function setSelectValue(id: string, value: string) {
  (document.getElementById(id) as HTMLSelectElement).value = value;
}

function setInputValue(id: string, value: string) {
  (document.getElementById(id) as HTMLInputElement).value = value;
}

function setChecked(id: string, checked: boolean) {
  (document.getElementById(id) as HTMLInputElement).checked = checked;
}

beforeEach(() => {
  state.currentSettings = { ...SETTING_DEFAULTS };
  state.logDirectory = "";
});

describe("applyTheme", () => {
  it('sets data-theme to "dark"', () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it('sets data-theme to "light"', () => {
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it('resolves "system" using matchMedia', () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: query === "(prefers-color-scheme: dark)",
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    applyTheme("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("applySettingsToForm", () => {
  it("applies all settings to main form", () => {
    state.currentSettings = {
      ...SETTING_DEFAULTS,
      format: "zip",
      level: "9",
      method: "deflate",
      dict: "128m",
      wordSize: "128",
      solid: "solid",
      threads: 4,
      pathMode: "absolute",
      sfx: true,
      encryptHeaders: true,
      deleteAfter: true,
    };

    applySettingsToForm();

    expect(getSelectValue("format")).toBe("zip");
    expect(getSelectValue("level")).toBe("9");
    expect(getSelectValue("method")).toBe("deflate");
    expect(getSelectValue("dict")).toBe("128m");
    expect(getSelectValue("word-size")).toBe("128");
    expect(getSelectValue("solid")).toBe("solid");
    expect(getInputValue("threads")).toBe("4");
    expect(getSelectValue("path-mode")).toBe("absolute");
    expect(getChecked("sfx")).toBe(true);
    expect(getChecked("encrypt-headers")).toBe(true);
    expect(getChecked("delete-after")).toBe(true);
  });

  it("applies defaults when state has defaults", () => {
    state.currentSettings = { ...SETTING_DEFAULTS };
    applySettingsToForm();

    expect(getSelectValue("format")).toBe(SETTING_DEFAULTS.format);
    expect(getSelectValue("level")).toBe(SETTING_DEFAULTS.level);
    expect(getChecked("sfx")).toBe(false);
    expect(getChecked("encrypt-headers")).toBe(false);
    expect(getChecked("delete-after")).toBe(false);
  });
});

describe("populateSettingsModal", () => {
  it("populates all settings modal fields from state", () => {
    state.currentSettings = {
      ...SETTING_DEFAULTS,
      theme: "dark",
      format: "zip",
      level: "7",
      method: "deflate",
      dict: "32m",
      wordSize: "32",
      solid: "4g",
      threads: 8,
      pathMode: "absolute",
      sfx: true,
      encryptHeaders: false,
      deleteAfter: true,
      autoCheckUpdates: false,
      localLoggingEnabled: true,
      logVerbosity: "debug",
    };
    state.logDirectory = "/var/log/zinnia";

    populateSettingsModal();

    expect(getSelectValue("s-theme")).toBe("dark");
    expect(getSelectValue("s-format")).toBe("zip");
    expect(getSelectValue("s-level")).toBe("7");
    expect(getSelectValue("s-method")).toBe("deflate");
    expect(getSelectValue("s-dict")).toBe("32m");
    expect(getSelectValue("s-word-size")).toBe("32");
    expect(getSelectValue("s-solid")).toBe("4g");
    expect(getInputValue("s-threads")).toBe("8");
    expect(getSelectValue("s-path-mode")).toBe("absolute");
    expect(getChecked("s-sfx")).toBe(true);
    expect(getChecked("s-encrypt-headers")).toBe(false);
    expect(getChecked("s-delete-after")).toBe(true);
    expect(getChecked("s-auto-check-updates")).toBe(false);
    expect(getChecked("s-local-logging")).toBe(true);
    expect(getSelectValue("s-log-verbosity")).toBe("debug");
  });

  it("sets log directory text", () => {
    state.logDirectory = "/home/user/.local/share/zinnia/logs";
    populateSettingsModal();
    const logDir = document.getElementById("s-log-dir")!;
    expect(logDir.textContent).toBe("/home/user/.local/share/zinnia/logs");
  });

  it('shows "Unavailable" when log directory is empty', () => {
    state.logDirectory = "";
    populateSettingsModal();
    const logDir = document.getElementById("s-log-dir")!;
    expect(logDir.textContent).toBe("Unavailable");
  });
});

describe("readSettingsModal", () => {
  it("reads all settings from modal form", () => {
    setSelectValue("s-theme", "dark");
    setSelectValue("s-format", "7z");
    setSelectValue("s-level", "9");
    setSelectValue("s-method", "lzma2");
    setSelectValue("s-dict", "512m");
    setSelectValue("s-word-size", "128");
    setSelectValue("s-solid", "solid");
    setInputValue("s-threads", "4");
    setSelectValue("s-path-mode", "relative");
    setChecked("s-sfx", false);
    setChecked("s-encrypt-headers", true);
    setChecked("s-delete-after", false);
    setChecked("s-auto-check-updates", true);
    setChecked("s-local-logging", true);
    setSelectValue("s-log-verbosity", "debug");

    const settings = readSettingsModal();
    expect(settings.theme).toBe("dark");
    expect(settings.format).toBe("7z");
    expect(settings.level).toBe("9");
    expect(settings.method).toBe("lzma2");
    expect(settings.dict).toBe("512m");
    expect(settings.wordSize).toBe("128");
    expect(settings.solid).toBe("solid");
    expect(settings.threads).toBe(4);
    expect(settings.pathMode).toBe("relative");
    expect(settings.sfx).toBe(false);
    expect(settings.encryptHeaders).toBe(true);
    expect(settings.deleteAfter).toBe(false);
    expect(settings.autoCheckUpdates).toBe(true);
    expect(settings.localLoggingEnabled).toBe(true);
    expect(settings.logVerbosity).toBe("debug");
  });

  it("disables encryptHeaders for formats that don't support it", () => {
    setSelectValue("s-format", "zip");
    setChecked("s-encrypt-headers", true);

    const settings = readSettingsModal();
    expect(settings.encryptHeaders).toBe(false);
  });

  it("round-trips settings through populate and read", () => {
    const original = {
      ...SETTING_DEFAULTS,
      theme: "light" as const,
      format: "7z" as const,
      level: "7",
      method: "lzma2",
      dict: "128m",
      wordSize: "64",
      solid: "16g",
      threads: 2,
      pathMode: "relative" as const,
      sfx: true,
      encryptHeaders: true,
      deleteAfter: false,
      autoCheckUpdates: true,
      localLoggingEnabled: false,
      logVerbosity: "info" as const,
    };
    state.currentSettings = { ...original };
    populateSettingsModal();
    const result = readSettingsModal();

    expect(result.theme).toBe(original.theme);
    expect(result.format).toBe(original.format);
    expect(result.level).toBe(original.level);
    expect(result.threads).toBe(original.threads);
    expect(result.sfx).toBe(original.sfx);
    expect(result.encryptHeaders).toBe(original.encryptHeaders);
    expect(result.autoCheckUpdates).toBe(original.autoCheckUpdates);
  });
});

describe("syncSettingsSecurityControlsForFormat", () => {
  it("disables encrypt-headers for zip", () => {
    setChecked("s-encrypt-headers", true);
    syncSettingsSecurityControlsForFormat("zip");
    const el = document.getElementById("s-encrypt-headers") as HTMLInputElement;
    expect(el.disabled).toBe(true);
    expect(el.checked).toBe(false);
  });

  it("enables encrypt-headers for 7z", () => {
    syncSettingsSecurityControlsForFormat("7z");
    const el = document.getElementById("s-encrypt-headers") as HTMLInputElement;
    expect(el.disabled).toBe(false);
  });

  it("disables encrypt-headers for tar", () => {
    syncSettingsSecurityControlsForFormat("tar");
    const el = document.getElementById("s-encrypt-headers") as HTMLInputElement;
    expect(el.disabled).toBe(true);
  });
});

describe("openSettingsModal / closeSettingsModal", () => {
  it("shows settings overlay on open", () => {
    const overlay = document.getElementById("settings-overlay")!;
    overlay.hidden = true;
    openSettingsModal();
    expect(overlay.hidden).toBe(false);
  });

  it("hides settings overlay on close", () => {
    const overlay = document.getElementById("settings-overlay")!;
    overlay.hidden = false;
    closeSettingsModal();
    expect(overlay.hidden).toBe(true);
  });
});
