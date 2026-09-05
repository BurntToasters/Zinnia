import { describe, it, expect, beforeEach } from "vitest";
import {
  applyTheme,
  applySettingsToForm,
  populateSettingsModal,
  readSettingsModal,
  syncSettingsSecurityControlsForFormat,
  openSettingsModal,
  closeSettingsModal,
  toggleSettingsModal,
  syncQuickExtractWarmIdleControl,
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
  state.running = false;
  state.operationPreparing = false;
  state.incomingPathsApplying = false;
  setSelectValue("format", SETTING_DEFAULTS.format);
  setSelectValue("level", SETTING_DEFAULTS.level);
  setSelectValue("method", SETTING_DEFAULTS.method);
  setSelectValue("dict", SETTING_DEFAULTS.dict);
  setSelectValue("word-size", SETTING_DEFAULTS.wordSize);
  setSelectValue("solid", SETTING_DEFAULTS.solid);
  setInputValue("threads", String(SETTING_DEFAULTS.threads));
  setChecked("encrypt-headers", SETTING_DEFAULTS.encryptHeaders);
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
      pathMode: "relative",
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
    expect(getSelectValue("path-mode")).toBe("relative");
    expect(getChecked("sfx")).toBe(false);
    expect(getChecked("encrypt-headers")).toBe(true);
    expect(getChecked("delete-after")).toBe(false);
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
      pathMode: "relative",
      sfx: true,
      encryptHeaders: false,
      deleteAfter: true,
      autoCheckUpdates: false,
      updateChannel: "beta",
      localLoggingEnabled: true,
      logVerbosity: "debug",
    };
    state.logDirectory = "/var/log/zinnia";
    setSelectValue("format", "zip");
    setSelectValue("level", "7");
    setSelectValue("method", "deflate");
    setSelectValue("dict", "32m");
    setSelectValue("word-size", "32");
    setSelectValue("solid", "4g");
    setInputValue("threads", "8");

    populateSettingsModal();

    expect(getSelectValue("s-theme")).toBe("dark");
    expect(getSelectValue("s-format")).toBe("zip");
    expect(getSelectValue("s-level")).toBe("7");
    expect(getSelectValue("s-method")).toBe("deflate");
    expect(getSelectValue("s-dict")).toBe("32m");
    expect(getSelectValue("s-word-size")).toBe("32");
    expect(getSelectValue("s-solid")).toBe("4g");
    expect(getInputValue("s-threads")).toBe("8");
    expect(getSelectValue("s-path-mode")).toBe("relative");
    expect(getChecked("s-sfx")).toBe(false);
    expect(getChecked("s-encrypt-headers")).toBe(false);
    expect(getChecked("s-delete-after")).toBe(false);
    expect(getChecked("s-auto-check-updates")).toBe(false);
    expect(getSelectValue("s-update-channel")).toBe("beta");
    expect(getChecked("s-local-logging")).toBe(true);
    expect(getSelectValue("s-log-verbosity")).toBe("debug");
    expect(getSelectValue("s-workspace-mode")).toBe("basic");
    expect(getSelectValue("s-ui-density")).toBe("comfortable");
    expect(getChecked("s-quick-extract-keep-warm")).toBe(false);
    expect(getSelectValue("s-quick-extract-warm-idle")).toBe("10");
  });

  it("sets log directory text", () => {
    state.logDirectory = "/home/user/.local/share/zinnia/logs";
    populateSettingsModal();
    const logDir = document.getElementById("s-log-dir")!;
    expect(logDir.textContent).toBe("/home/user/.local/share/zinnia/logs");
    expect(logDir.title).toBe("/home/user/.local/share/zinnia/logs");
  });

  it('shows "Unavailable" when log directory is empty', () => {
    state.logDirectory = "";
    populateSettingsModal();
    const logDir = document.getElementById("s-log-dir")!;
    expect(logDir.textContent).toBe("Unavailable");
    expect(logDir.title).toBe("");
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
    setSelectValue("s-update-channel", "beta");
    setChecked("s-local-logging", true);
    setSelectValue("s-log-verbosity", "debug");
    setSelectValue("s-workspace-mode", "power");
    setSelectValue("s-ui-density", "compact");
    setChecked("s-os-integration-dismissed", true);
    setChecked("s-quick-extract-keep-warm", false);
    setSelectValue("s-quick-extract-warm-idle", "30");
    setChecked("s-basic-window-effects", true);

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
    expect(settings.updateChannel).toBe("beta");
    expect(settings.localLoggingEnabled).toBe(true);
    expect(settings.logVerbosity).toBe("debug");
    expect(settings.workspaceMode).toBe("power");
    expect(settings.uiDensity).toBe("compact");
    expect(settings.osIntegrationDismissed).toBe(true);
    expect(settings.quickExtractKeepWarm).toBe(false);
    expect(settings.quickExtractWarmIdleMinutes).toBe(30);
    expect(settings.basicWindowEffects).toBe(true);
  });

  it("disables encryptHeaders for formats that don't support it", () => {
    setSelectValue("s-format", "zip");
    setChecked("s-encrypt-headers", true);

    const settings = readSettingsModal();
    expect(settings.encryptHeaders).toBe(false);
  });

  it("preserves working context settings from current state", () => {
    state.currentSettings.lastMode = "extract";
    state.currentSettings.showActivityPanel = true;
    state.currentSettings.debug = true;
    state.currentSettings.debugConsolePoppedOut = true;

    const settings = readSettingsModal();
    expect(settings.lastMode).toBe("extract");
    expect(settings.showActivityPanel).toBe(true);
    expect(settings.debug).toBe(true);
    expect(settings.debugConsolePoppedOut).toBe(true);
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
      updateChannel: "stable" as const,
      localLoggingEnabled: false,
      logVerbosity: "info" as const,
    };
    state.currentSettings = { ...original };
    setSelectValue("format", original.format);
    setSelectValue("level", original.level);
    setSelectValue("method", original.method);
    setSelectValue("dict", original.dict);
    setSelectValue("word-size", original.wordSize);
    setSelectValue("solid", original.solid);
    setInputValue("threads", String(original.threads));
    setChecked("encrypt-headers", original.encryptHeaders);
    populateSettingsModal();
    const result = readSettingsModal();

    expect(result.theme).toBe(original.theme);
    expect(result.format).toBe(original.format);
    expect(result.level).toBe(original.level);
    expect(result.threads).toBe(original.threads);
    expect(result.sfx).toBe(false);
    expect(result.encryptHeaders).toBe(original.encryptHeaders);
    expect(result.autoCheckUpdates).toBe(original.autoCheckUpdates);
    expect(result.updateChannel).toBe(original.updateChannel);
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

describe("syncQuickExtractWarmIdleControl", () => {
  it("disables idle timeout select when keep-warm is off", () => {
    setChecked("s-quick-extract-keep-warm", false);
    syncQuickExtractWarmIdleControl();
    expect(
      (
        document.getElementById(
          "s-quick-extract-warm-idle",
        ) as HTMLSelectElement
      ).disabled,
    ).toBe(true);

    setChecked("s-quick-extract-keep-warm", true);
    syncQuickExtractWarmIdleControl();
    expect(
      (
        document.getElementById(
          "s-quick-extract-warm-idle",
        ) as HTMLSelectElement
      ).disabled,
    ).toBe(false);
  });
});

describe("openSettingsModal / closeSettingsModal", () => {
  it("shows settings overlay on open", () => {
    const overlay = document.getElementById("settings-overlay")!;
    const trigger = document.getElementById("open-settings")!;
    overlay.hidden = true;
    openSettingsModal();
    expect(overlay.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it.each(["running", "operationPreparing", "incomingPathsApplying"] as const)(
    "does not open settings while %s",
    (flag) => {
      const overlay = document.getElementById("settings-overlay")!;
      overlay.hidden = true;
      state[flag] = true;

      openSettingsModal();

      expect(overlay.hidden).toBe(true);
    },
  );

  it("is a no-op when settings are already open", () => {
    const overlay = document.getElementById("settings-overlay")!;
    overlay.hidden = true;
    openSettingsModal();
    const basicFx = document.getElementById(
      "s-basic-window-effects",
    ) as HTMLInputElement | null;
    if (basicFx) basicFx.checked = !basicFx.checked;
    openSettingsModal();
    expect(overlay.hidden).toBe(false);
  });

  it("toggles settings open and closed", () => {
    const overlay = document.getElementById("settings-overlay")!;
    const trigger = document.getElementById("open-settings")!;
    overlay.hidden = true;
    toggleSettingsModal();
    expect(overlay.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    toggleSettingsModal();
    expect(overlay.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("hides settings overlay on close", () => {
    const overlay = document.getElementById("settings-overlay")!;
    const trigger = document.getElementById("open-settings")!;
    overlay.hidden = false;
    closeSettingsModal();
    expect(overlay.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("restores the live window-effects preview when settings are cancelled", () => {
    state.currentSettings.basicWindowEffects = true;
    openSettingsModal();
    const basicFx = document.getElementById(
      "s-basic-window-effects",
    ) as HTMLInputElement;
    basicFx.checked = false;
    basicFx.dispatchEvent(new Event("change"));

    expect(state.currentSettings.basicWindowEffects).toBe(false);
    closeSettingsModal();

    expect(state.currentSettings.basicWindowEffects).toBe(true);
  });
});
