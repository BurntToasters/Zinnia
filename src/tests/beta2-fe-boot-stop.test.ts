import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { SETTING_DEFAULTS } from "../settings-model";

type Handler = (event: { payload: unknown }) => void;

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  runExtractWindow: vi.fn(),
  applyTheme: vi.fn(),
  loadSettingsWithMetadata: vi.fn(),
  applySettingsToForm: vi.fn(),
  log: vi.fn(),
  devLog: vi.fn(),
  renderInputs: vi.fn(),
  setWorkspaceMode: vi.fn(),
  setUiDensity: vi.fn(),
  registerIconRefreshHook: vi.fn(),
  refreshIcons: vi.fn(),
  shouldShowSetupWizard: vi.fn(),
  runSetupWizardFlow: vi.fn(),
  applyIncomingPaths: vi.fn(),
  isE2eFrontend: vi.fn(),
  browseArchive: vi.fn(),
  refreshOsIntegrationStatus: vi.fn(),
  autoCheckUpdates: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const askMock = vi.mocked(ask);
const windowMock = vi.mocked(getCurrentWebviewWindow);
const versionMock = vi.mocked(getVersion);

const handlers = new Map<string, Handler>();

function makeWindow() {
  return {
    label: "main",
    minimize: vi.fn().mockResolvedValue(undefined),
    maximize: vi.fn().mockResolvedValue(undefined),
    unmaximize: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    close: vi.fn().mockResolvedValue(undefined),
    onResized: vi.fn().mockResolvedValue(() => {}),
    onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
  };
}

let appWindow = makeWindow();

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mountMainShell(): void {
  const shell = document.createElement("div");
  shell.id = "beta2-main-shell";
  shell.innerHTML = `
    <div id="titlebar">
      <button type="button" id="titlebar-min" class="titlebar-btn" aria-label="Minimize"></button>
      <button type="button" id="titlebar-max" class="titlebar-btn" aria-label="Maximize"></button>
      <button type="button" id="titlebar-close" class="titlebar-btn titlebar-btn--close" aria-label="Close"></button>
    </div>
    <main id="main-content"><div id="basic-workspace"></div></main>
  `;
  document.body.appendChild(shell);
}

function mountExtractShell(): void {
  const shell = document.createElement("div");
  shell.id = "beta2-extract-shell";
  shell.innerHTML = `
    <div id="titlebar">
      <button type="button" id="titlebar-min" class="titlebar-btn" aria-label="Minimize"></button>
      <button type="button" id="titlebar-close" class="titlebar-btn titlebar-btn--close" aria-label="Close"></button>
    </div>
    <main id="extract-app" class="extract-app">
      <div class="extract-header"><h1>Extracting</h1></div>
      <div class="extract-body"><div id="extract-status">Preparing...</div></div>
      <div class="extract-footer"><button class="btn" id="cancel-btn">Cancel</button></div>
    </main>
  `;
  document.body.appendChild(shell);
}

function findButton(root: ParentNode, label: string): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  );
}

async function startMainWithInitFailure(failure: unknown): Promise<void> {
  mocks.init.mockRejectedValue(failure);
  vi.doMock("../app-init", () => ({ init: mocks.init }));
  vi.doMock("../benchmark", () => ({ parseBenchmarkSummary: vi.fn() }));
  vi.doMock("../icons", () => ({ refreshIcons: vi.fn() }));
  const { startup } = await import("../main");
  await startup;
}

async function startExtractWithRunFailure(failure: unknown): Promise<void> {
  mocks.runExtractWindow.mockRejectedValue(failure);
  vi.doMock("../extract-window/run-core", () => ({
    runExtractWindow: mocks.runExtractWindow,
  }));
  await import("../extract-window");
  await flush();
}

describe("fatal startup in the main window", () => {
  beforeEach(() => {
    vi.resetModules();
    appWindow = makeWindow();
    windowMock.mockReturnValue(appWindow as never);
    mountMainShell();
  });

  afterEach(() => {
    document.getElementById("beta2-main-shell")?.remove();
  });

  it("keeps the titlebar and shows an alert with a Close button that closes the window", async () => {
    await startMainWithInitFailure(new Error("settings schema exploded"));

    expect(document.getElementById("titlebar")).not.toBeNull();
    const alert = document.querySelector("#main-content [role='alert']");
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Failed to start");
    expect(alert?.textContent).toContain("settings schema exploded");
    const close = findButton(alert ?? document, "Close");
    expect(close).toBeInstanceOf(HTMLButtonElement);
    close?.click();
    expect(appWindow.close).toHaveBeenCalledTimes(1);
  });

  it("keeps titlebar minimize and close working when init fails before wiring the titlebar", async () => {
    await startMainWithInitFailure(new Error("boom"));

    document.getElementById("titlebar-min")?.click();
    document.getElementById("titlebar-close")?.click();

    expect(appWindow.minimize).toHaveBeenCalledTimes(1);
    expect(appWindow.close).toHaveBeenCalledTimes(1);
  });

  it("closes once when a titlebar listener was attached before the failure", async () => {
    document.getElementById("titlebar-close")?.addEventListener("click", () => {
      void appWindow.close();
    });

    await startMainWithInitFailure(new Error("boom"));
    document.getElementById("titlebar-close")?.click();

    expect(appWindow.close).toHaveBeenCalledTimes(1);
  });

  it("renders the error as text and never as markup", async () => {
    const hostile = '<img src="x" alt="injected">';
    await startMainWithInitFailure(new Error(hostile));

    expect(document.querySelector("#main-content img")).toBeNull();
    expect(
      document.querySelector("#main-content [role='alert']")?.textContent,
    ).toContain(hostile);
  });

  it("renders a non-Error rejection as text", async () => {
    await startMainWithInitFailure("plain failure text");

    expect(
      document.querySelector("#main-content [role='alert']")?.textContent,
    ).toContain("plain failure text");
  });

  it("disables Maximize in the fatal state so it cannot be a dead control", async () => {
    await startMainWithInitFailure(new Error("boom"));

    const maximize = document.getElementById(
      "titlebar-max",
    ) as HTMLButtonElement | null;
    expect(maximize?.disabled).toBe(true);
  });
});

describe("fatal startup in the extract window", () => {
  beforeEach(() => {
    vi.resetModules();
    appWindow = makeWindow();
    windowMock.mockReturnValue(appWindow as never);
    mountExtractShell();
  });

  afterEach(() => {
    document.getElementById("beta2-extract-shell")?.remove();
  });

  it("keeps the titlebar and replaces the body with an alert and Close button", async () => {
    await startExtractWithRunFailure(new Error("archive slot unavailable"));

    expect(document.getElementById("titlebar")).not.toBeNull();
    const alert = document.querySelector("#extract-app [role='alert']");
    expect(alert?.textContent).toContain("archive slot unavailable");
    expect(document.getElementById("cancel-btn")).toBeNull();
    const close = findButton(alert ?? document, "Close");
    expect(close).toBeInstanceOf(HTMLButtonElement);
    close?.click();
    expect(appWindow.close).toHaveBeenCalledTimes(1);
  });

  it("wires titlebar minimize and close after a run failure", async () => {
    await startExtractWithRunFailure(new Error("boom"));

    document.getElementById("titlebar-min")?.click();
    document.getElementById("titlebar-close")?.click();

    expect(appWindow.minimize).toHaveBeenCalledTimes(1);
    expect(appWindow.close).toHaveBeenCalledTimes(1);
  });
});

const CORE_ELEMENTS: [string, string][] = [
  ["app", "div"],
  ["input-list", "div"],
  ["log", "div"],
  ["status", "div"],
  ["progress", "div"],
  ["version-label", "div"],
  ["platform-label", "div"],
  ["run-action", "button"],
  ["cancel-action", "button"],
  ["extract-run", "button"],
  ["extract-cancel", "button"],
];

function ensureCoreElements(): void {
  for (const [id, tag] of CORE_ELEMENTS) {
    if (document.getElementById(id)) continue;
    const element = document.createElement(tag);
    element.id = id;
    document.body.appendChild(element);
  }
}

function mountAppInitDom(): void {
  ensureCoreElements();
  document.getElementById("startup-recovery-banner")?.remove();
  const banner = document.createElement("div");
  banner.id = "startup-recovery-banner";
  banner.setAttribute("role", "alert");
  banner.hidden = true;
  const text = document.createElement("span");
  text.id = "startup-recovery-banner-text";
  const acknowledge = document.createElement("button");
  acknowledge.id = "startup-recovery-banner-acknowledge";
  acknowledge.hidden = true;
  const dismiss = document.createElement("button");
  dismiss.id = "startup-recovery-banner-dismiss";
  banner.append(text, acknowledge, dismiss);
  document.body.appendChild(banner);

  if (!document.getElementById("format")) {
    const select = document.createElement("select");
    select.id = "format";
    const option = document.createElement("option");
    option.value = "7z";
    option.textContent = "7z";
    select.appendChild(option);
    document.body.appendChild(select);
  }
  for (const id of ["s-version-label", "s-platform-label"]) {
    if (!document.getElementById(id)) {
      const label = document.createElement("div");
      label.id = id;
      document.body.appendChild(label);
    }
  }
}

function mockAppInitDeps(): void {
  vi.doUnmock("../app-init");
  vi.doMock("../settings", () => ({
    applyTheme: mocks.applyTheme,
    loadSettingsWithMetadata: mocks.loadSettingsWithMetadata,
    applySettingsToForm: mocks.applySettingsToForm,
    openSettingsModal: vi.fn(),
  }));
  vi.doMock("../ui", () => ({
    log: mocks.log,
    devLog: mocks.devLog,
    renderInputs: mocks.renderInputs,
    setMode: vi.fn(),
    setActivityPanelVisible: vi.fn(),
    setWorkspaceMode: mocks.setWorkspaceMode,
    getWorkspaceMode: vi.fn(() => "basic"),
    setUiDensity: mocks.setUiDensity,
    getMode: vi.fn(() => "add"),
    setBrowsePasswordFieldVisible: vi.fn(),
    registerIconRefreshHook: mocks.registerIconRefreshHook,
  }));
  vi.doMock("../archive", () => ({ browseArchive: mocks.browseArchive }));
  vi.doMock("../archive-rules", () => ({ MAX_ARCHIVE_PATHS: 4096 }));
  vi.doMock("../presets", () => ({
    updateCompressionOptionsForFormat: vi.fn(),
    onCompressionOptionChange: vi.fn(),
  }));
  vi.doMock("../updater", () => ({
    checkUpdates: vi.fn(),
    autoCheckUpdates: mocks.autoCheckUpdates,
  }));
  vi.doMock("../licenses", () => ({ openLicensesModal: vi.fn() }));
  vi.doMock("../external-links", () => ({ openExternalUrl: vi.fn() }));
  vi.doMock("../quick-actions", () => ({
    refreshQuickActionRepeatState: vi.fn(),
  }));
  vi.doMock("../e2e-env", () => ({ isE2eFrontend: mocks.isE2eFrontend }));
  vi.doMock("../e2e-hook", () => ({ installE2eHookIfEnabled: vi.fn() }));
  vi.doMock("../webview-context-menu", () => ({
    installNativeWebviewContextMenuGuard: vi.fn(),
  }));
  vi.doMock("../setup-wizard", () => ({
    shouldShowSetupWizard: mocks.shouldShowSetupWizard,
  }));
  vi.doMock("../power-events", () => ({
    wireEvents: vi.fn(),
    openShortcutsModal: vi.fn(),
    runSetupWizardFlow: mocks.runSetupWizardFlow,
  }));
  vi.doMock("../basic", () => ({
    initBasicWorkspace: vi.fn(),
    handleBasicDragDrop: vi.fn(),
  }));
  vi.doMock("../os-integration", () => ({
    refreshOsIntegrationStatus: mocks.refreshOsIntegrationStatus,
  }));
  vi.doMock("../icons", () => ({ refreshIcons: mocks.refreshIcons }));
  vi.doMock("../debug-mode", () => ({
    setDebugEnabled: vi.fn(),
    debugLog: vi.fn(),
    restoreDebugConsolePopOutIfNeeded: vi.fn(),
  }));
  vi.doMock("../incoming-paths", () => ({
    allPathsAreArchives: vi.fn(async () => false),
    applyIncomingPaths: mocks.applyIncomingPaths,
    acquireIncomingPathLock: vi.fn(async () => undefined),
    isIncomingPathBusy: vi.fn(() => false),
    notifyIncomingPathsQueuedIfBusy: vi.fn(),
    releaseIncomingPathLock: vi.fn(),
  }));
}

function routeInvoke(
  custom?: (command: string, payload?: unknown) => unknown,
): void {
  invokeMock.mockImplementation((command, payload) => {
    const reply = custom?.(command, payload);
    if (reply !== undefined) return Promise.resolve(reply) as never;
    switch (command) {
      case "get_platform_info":
        return Promise.resolve("linux") as never;
      case "get_cpu_count":
        return Promise.resolve(8) as never;
      case "get_log_dir":
        return Promise.resolve("/tmp/logs") as never;
      case "is_packaged":
        return Promise.resolve(true) as never;
      case "is_flatpak":
        return Promise.resolve(false) as never;
      case "get_initial_mode":
        return Promise.resolve("") as never;
      case "get_initial_paths":
        return Promise.resolve([]) as never;
      case "drain_pending_paths":
        return Promise.resolve([]) as never;
      case "get_startup_recovery_status":
        return Promise.resolve(null) as never;
      case "get_shell_handoff_error":
        return Promise.resolve(null) as never;
      case "load_settings":
        return Promise.resolve("{}") as never;
      default:
        return Promise.resolve(undefined) as never;
    }
  });
}

function bannerText(): string {
  return (
    document.getElementById("startup-recovery-banner-text")?.textContent ?? ""
  );
}

function bannerElement(): HTMLElement {
  const banner = document.getElementById("startup-recovery-banner");
  if (!banner) throw new Error("missing banner");
  return banner;
}

function acknowledgeButton(): HTMLButtonElement {
  return document.getElementById(
    "startup-recovery-banner-acknowledge",
  ) as HTMLButtonElement;
}

async function bootApp(): Promise<void> {
  const { init } = await import("../app-init");
  await init();
  await flush();
}

describe("main window bootstrap ordering and banner", () => {
  beforeEach(() => {
    vi.resetModules();
    mockAppInitDeps();
    mountAppInitDom();
    handlers.clear();
    appWindow = makeWindow();
    windowMock.mockReturnValue(appWindow as never);

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: "(prefers-color-scheme: dark)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });

    listenMock.mockImplementation(async (event, handler) => {
      handlers.set(event, handler as unknown as Handler);
      return () => {};
    });
    versionMock.mockResolvedValue("1.2.3");
    askMock.mockResolvedValue(false);
    mocks.loadSettingsWithMetadata.mockResolvedValue({
      settings: {
        ...SETTING_DEFAULTS,
        workspaceMode: "basic",
        uiDensity: "comfortable",
        autoCheckUpdates: false,
        lastMode: "add",
        showActivityPanel: true,
        theme: "system",
        setupComplete: true,
      },
      extras: {},
      malformed: false,
      warning: undefined,
    });
    mocks.isE2eFrontend.mockReturnValue(false);
    mocks.refreshOsIntegrationStatus.mockResolvedValue(undefined);
    mocks.applyIncomingPaths.mockResolvedValue(undefined);
    mocks.shouldShowSetupWizard.mockReturnValue(false);
    routeInvoke();
  });

  afterEach(() => {
    document.getElementById("startup-recovery-banner")?.remove();
  });

  it("applies theme, density and icons before the setup wizard renders", async () => {
    mocks.shouldShowSetupWizard.mockReturnValue(true);
    mocks.runSetupWizardFlow.mockResolvedValue(undefined);

    await bootApp();

    const wizardCall = mocks.runSetupWizardFlow.mock.invocationCallOrder[0];
    expect(wizardCall).toBeDefined();
    expect(mocks.applyTheme.mock.invocationCallOrder[0]).toBeLessThan(
      wizardCall ?? 0,
    );
    expect(mocks.setUiDensity.mock.invocationCallOrder[0]).toBeLessThan(
      wizardCall ?? 0,
    );
    expect(mocks.refreshIcons.mock.invocationCallOrder[0]).toBeLessThan(
      wizardCall ?? 0,
    );
  });

  it("leaves the workspace mode to the wizard instead of applying it first", async () => {
    mocks.shouldShowSetupWizard.mockReturnValue(true);
    mocks.runSetupWizardFlow.mockResolvedValue(undefined);

    await bootApp();

    const wizardCall =
      mocks.runSetupWizardFlow.mock.invocationCallOrder[0] ?? 0;
    for (const order of mocks.setWorkspaceMode.mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(wizardCall);
    }
  });

  it("keeps only the newest three distinct banner messages, newest last", async () => {
    await bootApp();
    const dropped = handlers.get("open-paths-dropped");
    expect(dropped).toBeDefined();

    for (const message of [
      "first note",
      "second note",
      "second note",
      "third note",
      "fourth note",
    ]) {
      dropped?.({ payload: message });
    }

    expect(bannerText()).toBe("second note third note fourth note");
    expect(bannerElement().hidden).toBe(false);
  });

  it("clears the banner list on dismiss so the next warning starts fresh", async () => {
    await bootApp();
    handlers.get("open-paths-dropped")?.({ payload: "old warning" });

    document.getElementById("startup-recovery-banner-dismiss")?.click();
    expect(bannerElement().hidden).toBe(true);
    expect(bannerText()).toBe("");

    handlers.get("open-paths-dropped")?.({ payload: "new warning" });
    expect(bannerText()).toBe("new warning");
  });

  it("replaces the pending text with the backend success message after acknowledging", async () => {
    routeInvoke((command) => {
      if (command === "get_startup_recovery_status") {
        return { kind: "ambiguous", message: "Pending journal message." };
      }
      if (command === "acknowledge_preserved_transaction") {
        return "Recovery marker cleared.";
      }
      return undefined;
    });
    askMock.mockResolvedValue(true);

    await bootApp();
    expect(bannerText()).toContain("Pending journal message.");
    acknowledgeButton().click();
    await flush();

    expect(bannerText()).toBe("Recovery marker cleared.");
    expect(acknowledgeButton().hidden).toBe(true);
  });

  it("keeps the recovery kind and pending text when acknowledging fails", async () => {
    routeInvoke((command) => {
      if (command === "get_startup_recovery_status") {
        return {
          kind: "newer",
          message: "Journal from a newer build is pending.",
        };
      }
      if (command === "acknowledge_preserved_transaction") {
        throw new Error("marker is locked");
      }
      return undefined;
    });
    askMock.mockResolvedValue(true);

    await bootApp();
    expect(acknowledgeButton().hidden).toBe(false);
    acknowledgeButton().click();
    await flush();

    expect(askMock.mock.calls[0]?.[1]).toMatchObject({
      title: "Accept job from newer Zinnia",
    });
    expect(bannerText()).toContain("Journal from a newer build is pending.");
    expect(bannerText()).toContain(
      "Could not clear the recovery marker: marker is locked",
    );
    expect(acknowledgeButton().hidden).toBe(false);

    acknowledgeButton().click();
    await flush();
    expect(askMock.mock.calls[1]?.[1]).toMatchObject({
      title: "Accept job from newer Zinnia",
    });
  });

  it("runs the initial pending-path drain through the open-paths queue, never beside an event drain", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const batches: { paths: string[]; mode: string }[][] = [
      [],
      [{ paths: ["/tmp/event.7z"], mode: "extract" }],
    ];
    routeInvoke((command) => {
      if (command === "get_initial_paths") return ["/tmp/launch.7z"];
      if (command === "get_initial_mode") return "extract";
      if (command === "drain_pending_paths") {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          setTimeout(() => {
            inFlight -= 1;
            resolve(batches.shift() ?? []);
          }, 20);
        });
      }
      return undefined;
    });
    let releaseLaunch: () => void = () => {};
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    mocks.applyIncomingPaths.mockImplementation(
      async (_paths: string[], _mode: string, source: string) => {
        if (source === "launch args") await launchGate;
      },
    );

    const { init } = await import("../app-init");
    const starting = init();
    await vi.waitFor(() =>
      expect(mocks.applyIncomingPaths).toHaveBeenCalledWith(
        ["/tmp/launch.7z"],
        "extract",
        "launch args",
      ),
    );
    handlers.get("pending-paths-changed")?.({ payload: undefined });
    releaseLaunch();
    await starting;

    await vi.waitFor(() =>
      expect(mocks.applyIncomingPaths).toHaveBeenCalledWith(
        ["/tmp/event.7z"],
        "extract",
        "Explorer",
      ),
    );
    expect(maxInFlight).toBe(1);
  });
});
