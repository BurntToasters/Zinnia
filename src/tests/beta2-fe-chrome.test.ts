import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { ask } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import {
  closeSettingsModal,
  isSettingsFileUnreadable,
  loadSettingsWithMetadata,
  openSettingsModal,
  SettingsFileReplacementDeclinedError,
  saveSettings,
} from "../settings";
import {
  persistSettingsImmediately,
  queuePersistWorkingContext,
  resizeWorkspaceWindow,
  setWorkspaceMode,
} from "../ui/workspace";
import { autoCheckUpdates, discardPendingUpdate } from "../updater";
import { confirmChoice } from "../prompt-modal";
import { state } from "../state";
import { SETTING_DEFAULTS } from "../settings-model";

const invokeMock = vi.mocked(invoke);
const askMock = vi.mocked(ask);
const checkMock = vi.mocked(check);
const getVersionMock = vi.mocked(getVersion);

const env = {
  loadRaw: JSON.stringify(SETTING_DEFAULTS),
  loadError: null as Error | null,
  saveError: null as Error | null,
};

function installInvokeDouble(): void {
  invokeMock.mockImplementation((command) => {
    if (command === "load_settings") {
      return env.loadError
        ? Promise.reject(env.loadError)
        : Promise.resolve(env.loadRaw);
    }
    if (command === "save_settings") {
      return env.saveError
        ? Promise.reject(env.saveError)
        : Promise.resolve(undefined);
    }
    return Promise.resolve(undefined);
  });
}

function saveCalls() {
  return invokeMock.mock.calls.filter(
    ([command]) => command === "save_settings",
  );
}

function lastSavedSettings(): Record<string, unknown> {
  const call = saveCalls().at(-1);
  return JSON.parse((call?.[1] as { json: string }).json) as Record<
    string,
    unknown
  >;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

function overlayOpen(id: string): boolean {
  return document.getElementById(id)?.hidden === false;
}

function clickId(id: string): void {
  document.getElementById(id)?.click();
}

async function becomeUnreadable(): Promise<void> {
  env.loadError = new Error("disk unavailable");
  await loadSettingsWithMetadata();
  env.loadError = null;
}

async function becomeReadable(): Promise<void> {
  env.loadRaw = JSON.stringify(SETTING_DEFAULTS);
  await loadSettingsWithMetadata();
}

beforeEach(() => {
  vi.useFakeTimers();
  installInvokeDouble();
  env.loadRaw = JSON.stringify(SETTING_DEFAULTS);
  env.loadError = null;
  env.saveError = null;
  state.currentSettings = { ...SETTING_DEFAULTS };
  state.settingsExtras = {};
  document.getElementById("toast-region")?.remove();
  const overlay = document.getElementById("input-modal-overlay");
  if (overlay) overlay.hidden = true;
});

afterEach(async () => {
  vi.clearAllTimers();
  env.loadError = null;
  env.saveError = null;
  await becomeReadable();
  vi.useRealTimers();
});

describe("unreadable settings file (M7)", () => {
  it("blocks debounced working-context saves after a failed load", async () => {
    await becomeUnreadable();

    expect(isSettingsFileUnreadable()).toBe(true);
    queuePersistWorkingContext();
    await vi.advanceTimersByTimeAsync(1000);

    expect(saveCalls()).toHaveLength(0);
  });

  it("re-checks the block when a save queued earlier fires after the load failed", async () => {
    queuePersistWorkingContext();
    await becomeUnreadable();
    await vi.advanceTimersByTimeAsync(1000);

    expect(saveCalls()).toHaveLength(0);
  });

  it("blocks saves for a malformed file, not only a failed invoke", async () => {
    env.loadRaw = "{ not valid json, theme: ";
    const result = await loadSettingsWithMetadata();

    expect(result.malformed).toBe(true);
    expect(isSettingsFileUnreadable()).toBe(true);
    queuePersistWorkingContext();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveCalls()).toHaveLength(0);
    await becomeReadable();
  });

  it("says automatic saves are paused and keeps the cause in the warning", async () => {
    env.loadError = new Error("disk unavailable");
    const result = await loadSettingsWithMetadata();
    env.loadError = null;

    expect(result.warning).toContain("disk unavailable");
    expect(result.warning).toContain("paused");
  });

  it("asks before an explicit save replaces the unreadable file and writes nothing when declined", async () => {
    await becomeUnreadable();

    const pending = saveSettings(SETTING_DEFAULTS, {});
    await settle();
    expect(overlayOpen("input-modal-overlay")).toBe(true);
    clickId("input-modal-cancel");

    await expect(pending).rejects.toBeInstanceOf(
      SettingsFileReplacementDeclinedError,
    );
    expect(saveCalls()).toHaveLength(0);
    expect(isSettingsFileUnreadable()).toBe(true);
  });

  it("routes an explicit persist through the same confirm and writes when accepted", async () => {
    await becomeUnreadable();

    const pending = persistSettingsImmediately(
      state.currentSettings,
      state.settingsExtras,
    );
    await settle();
    clickId("input-modal-confirm");
    await pending;

    expect(saveCalls()).toHaveLength(1);
    expect(isSettingsFileUnreadable()).toBe(false);
  });

  it("resumes automatic saves once the replacement has been written", async () => {
    await becomeUnreadable();
    const pending = saveSettings(SETTING_DEFAULTS, {});
    await settle();
    clickId("input-modal-confirm");
    await pending;

    queuePersistWorkingContext();
    await vi.advanceTimersByTimeAsync(1000);

    expect(saveCalls()).toHaveLength(2);
  });

  it("keeps the file unreadable when the confirmed write fails and asks again", async () => {
    await becomeUnreadable();
    env.saveError = new Error("disk full");
    const first = saveSettings(SETTING_DEFAULTS, {});
    await settle();
    clickId("input-modal-confirm");
    await expect(first).rejects.toThrow("disk full");

    expect(isSettingsFileUnreadable()).toBe(true);
    env.saveError = null;
    const second = saveSettings(SETTING_DEFAULTS, {});
    await settle();
    expect(overlayOpen("input-modal-overlay")).toBe(true);
    clickId("input-modal-cancel");
    await expect(second).rejects.toBeInstanceOf(
      SettingsFileReplacementDeclinedError,
    );
  });

  it("shows one failure toast for a run of failed working-context saves", async () => {
    env.saveError = new Error("disk full");
    queuePersistWorkingContext();
    await vi.advanceTimersByTimeAsync(200);
    queuePersistWorkingContext();
    await vi.advanceTimersByTimeAsync(200);
    queuePersistWorkingContext();
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    const failures = [
      ...document.querySelectorAll<HTMLElement>(".toast-message"),
    ].filter((el) => (el.textContent ?? "").startsWith("Could not save"));
    expect(failures).toHaveLength(1);
    expect(failures[0].textContent).toContain("disk full");
  });
});

describe("Settings save guard while the file is unreadable (M7)", () => {
  let saveButton: HTMLButtonElement;
  let saveListener: Mock<(event: Event) => void>;
  let modal: HTMLElement;

  beforeEach(() => {
    const overlay = document.getElementById("settings-overlay") as HTMLElement;
    overlay.hidden = true;
    modal = document.createElement("div");
    modal.className = "modal";
    saveButton = document.createElement("button");
    saveButton.id = "save-settings";
    modal.appendChild(saveButton);
    overlay.appendChild(modal);
    saveListener = vi.fn<(event: Event) => void>();
    saveButton.addEventListener("click", saveListener);
  });

  afterEach(() => {
    closeSettingsModal();
    saveButton.remove();
    modal.remove();
  });

  it("does not reach the Save handler until the replacement is confirmed", async () => {
    await becomeUnreadable();
    openSettingsModal();

    saveButton.click();
    await settle();
    expect(overlayOpen("input-modal-overlay")).toBe(true);
    expect(saveListener).not.toHaveBeenCalled();

    clickId("input-modal-cancel");
    await settle();
    expect(saveListener).not.toHaveBeenCalled();
    expect(overlayOpen("settings-overlay")).toBe(true);

    saveButton.click();
    await settle();
    clickId("input-modal-confirm");
    await settle();
    expect(saveListener).toHaveBeenCalledTimes(1);
  });

  it("asks again on the next Save after a confirmed replacement was used", async () => {
    await becomeUnreadable();
    openSettingsModal();

    saveButton.click();
    await settle();
    clickId("input-modal-confirm");
    await settle();
    expect(saveListener).toHaveBeenCalledTimes(1);

    saveButton.click();
    await settle();
    expect(overlayOpen("input-modal-overlay")).toBe(true);
    expect(saveListener).toHaveBeenCalledTimes(1);
    clickId("input-modal-cancel");
    await settle();
  });
});

describe("Settings live preview is not persisted (live-preview leak)", () => {
  beforeEach(() => {
    const overlay = document.getElementById("settings-overlay") as HTMLElement;
    overlay.hidden = true;
  });

  it("writes the committed window-effects value while a preview is open, then the state value after close", async () => {
    state.currentSettings.basicWindowEffects = false;
    openSettingsModal();
    const basicFx = document.getElementById(
      "s-basic-window-effects",
    ) as HTMLInputElement;
    basicFx.checked = true;
    basicFx.dispatchEvent(new Event("change"));
    expect(state.currentSettings.basicWindowEffects).toBe(true);

    queuePersistWorkingContext();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveCalls()).toHaveLength(1);
    expect(lastSavedSettings().basicWindowEffects).toBe(false);

    askMock.mockResolvedValueOnce(true);
    closeSettingsModal();
    await settle();
    expect(state.currentSettings.basicWindowEffects).toBe(false);

    state.currentSettings.basicWindowEffects = true;
    queuePersistWorkingContext();
    await vi.advanceTimersByTimeAsync(1000);
    expect(lastSavedSettings().basicWindowEffects).toBe(true);
  });
});

describe("Basic window fit (M9)", () => {
  let appWindow: {
    setSize: ReturnType<typeof vi.fn>;
    setResizable: ReturnType<typeof vi.fn>;
    setMaximizable: ReturnType<typeof vi.fn>;
    isMaximized: ReturnType<typeof vi.fn>;
    unmaximize: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useRealTimers();
    appWindow = {
      setSize: vi.fn().mockResolvedValue(undefined),
      setResizable: vi.fn().mockResolvedValue(undefined),
      setMaximizable: vi.fn().mockResolvedValue(undefined),
      isMaximized: vi.fn().mockResolvedValue(false),
      unmaximize: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(getCurrentWebviewWindow).mockReturnValue(
      appWindow as unknown as ReturnType<typeof getCurrentWebviewWindow>,
    );
  });

  afterEach(() => {
    Object.defineProperty(window.screen, "availHeight", {
      configurable: true,
      value: 0,
    });
  });

  function setAvailHeight(height: number): void {
    Object.defineProperty(window.screen, "availHeight", {
      configurable: true,
      value: height,
    });
  }

  function lastBasicSize(): unknown {
    return appWindow.setSize.mock.calls.at(-1)?.[0];
  }

  it("clamps the Basic height to a short work area and keeps the width", async () => {
    setAvailHeight(574);
    await resizeWorkspaceWindow("basic");

    expect(lastBasicSize()).toEqual(new LogicalSize(500, 574));
  });

  it("keeps the 650 height when the work area is tall", async () => {
    setAvailHeight(900);
    await resizeWorkspaceWindow("basic");

    expect(lastBasicSize()).toEqual(new LogicalSize(500, 650));
  });

  it("keeps the 650 height when the work area height is unknown", async () => {
    setAvailHeight(0);
    await resizeWorkspaceWindow("basic");

    expect(lastBasicSize()).toEqual(new LogicalSize(500, 650));
  });
});

describe("Basic update indicator mirror (M14)", () => {
  function fakeUpdate(version: string) {
    return {
      version,
      download: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    vi.useRealTimers();
    discardPendingUpdate();
    getVersionMock.mockResolvedValue("0.4.1");
    askMock.mockResolvedValue(false);
    document.getElementById("app")?.removeAttribute("data-workspace-mode");
  });

  afterEach(() => {
    discardPendingUpdate();
    document.getElementById("app")?.removeAttribute("data-workspace-mode");
  });

  it("mirrors a parked update in Basic, hides it in Power, and shows it again in Basic", async () => {
    const update = fakeUpdate("0.5.0");
    checkMock.mockResolvedValue(update as unknown as Update);
    await autoCheckUpdates();

    const basic = document.getElementById(
      "basic-update-indicator",
    ) as HTMLButtonElement;
    const status = document.getElementById(
      "update-ready-indicator",
    ) as HTMLButtonElement;
    expect(basic.hidden).toBe(false);
    expect(basic.textContent).toBe("Update 0.5.0 available. Click to install");
    expect(basic.title).toBe(basic.textContent);
    expect(status.hidden).toBe(false);

    setWorkspaceMode("power", { persist: false });
    expect(basic.hidden).toBe(true);
    expect(status.hidden).toBe(false);

    setWorkspaceMode("basic", { persist: false });
    expect(basic.hidden).toBe(false);
  });

  it("starts the same download from the Basic copy as from the status bar", async () => {
    const update = fakeUpdate("0.5.0");
    checkMock.mockResolvedValue(update as unknown as Update);
    await autoCheckUpdates();

    (
      document.getElementById("basic-update-indicator") as HTMLButtonElement
    ).click();

    await vi.waitFor(() => expect(update.download).toHaveBeenCalledOnce());
  });
});

describe("confirm dialog description and header inertness (M8, M6)", () => {
  it("points aria-describedby at the message element and removes it on close", async () => {
    const pending = confirmChoice({
      title: "Confirm",
      message: "Discard the draft?",
      confirmLabel: "Discard",
      cancelLabel: "Keep",
    });
    const dialog = document.querySelector<HTMLElement>(
      "#input-modal-overlay .modal",
    );
    const describedBy = dialog?.getAttribute("aria-describedby") ?? "";
    expect(describedBy).not.toBe("");
    expect(document.getElementById(describedBy)?.textContent).toBe(
      "Discard the draft?",
    );

    clickId("input-modal-confirm");
    await pending;

    expect(dialog?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("makes the titlebar and header inert while a confirm is open and restores them on close", async () => {
    const parent = document.getElementById("input-modal-overlay")!
      .parentElement as HTMLElement;
    const titlebar = document.createElement("div");
    titlebar.id = "titlebar";
    const header = document.createElement("header");
    header.className = "header";
    parent.append(titlebar, header);

    const pending = confirmChoice({
      title: "Confirm",
      message: "Continue?",
    });
    expect(titlebar.inert).toBe(true);
    expect(header.inert).toBe(true);

    clickId("input-modal-cancel");
    await pending;

    expect(titlebar.inert).toBe(false);
    expect(header.inert).toBe(false);
    titlebar.remove();
    header.remove();
  });
});
