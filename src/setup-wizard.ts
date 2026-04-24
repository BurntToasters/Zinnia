import { saveSettings, applyTheme } from "./settings";
import { state } from "./state";
import type {
  ThemePreference,
  WorkspaceMode,
  UpdateChannel,
} from "./settings-model";
import { trapFocus, releaseFocusTrap } from "./utils";

const SETUP_WIZARD_VERSION = 1;
const LAST_STEP = 4;

interface SetupWizardResult {
  workspaceMode: WorkspaceMode;
  theme: ThemePreference;
  autoCheckUpdates: boolean;
  updateChannel: UpdateChannel;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

function setProgress(step: number): void {
  const bar = $("setup-wizard-progress-bar");
  const pct = (step / LAST_STEP) * 100;
  bar.style.width = `${pct}%`;
}

function showStep(step: number): void {
  const steps = document.querySelectorAll<HTMLElement>(".setup-wizard-step");
  for (const s of steps) {
    const idx = Number(s.dataset.step);
    s.hidden = idx !== step;
  }
  setProgress(step);
}

export function shouldShowSetupWizard(): boolean {
  return (
    state.settingsExtras._setupComplete !== true ||
    state.settingsExtras._setupWizardVersion !== SETUP_WIZARD_VERSION
  );
}

export async function markSetupComplete(): Promise<void> {
  state.settingsExtras._setupComplete = true;
  state.settingsExtras._setupWizardVersion = SETUP_WIZARD_VERSION;
  await saveSettings(state.currentSettings, state.settingsExtras);
  state.lastPersistedSettings = { ...state.currentSettings };
}

export function showSetupWizard(): Promise<SetupWizardResult | null> {
  return new Promise((resolve) => {
    const overlay = $("setup-wizard-overlay");
    const card = overlay.querySelector<HTMLElement>(".setup-wizard-card");
    overlay.hidden = false;
    if (card) trapFocus(card);

    let selectedWorkspace: WorkspaceMode = state.currentSettings.workspaceMode;
    let selectedTheme: ThemePreference = state.currentSettings.theme;
    let selectedAutoUpdates = state.currentSettings.autoCheckUpdates;
    let selectedChannel: UpdateChannel =
      state.currentSettings.updateChannel === "beta" ||
      state.currentSettings.updateChannel === "auto"
        ? state.currentSettings.updateChannel
        : "stable";

    const welcomeNext = $("setup-welcome-next") as HTMLButtonElement;
    const welcomeSkip = $("setup-welcome-skip") as HTMLButtonElement;
    const workspaceBack = $("setup-workspace-back") as HTMLButtonElement;
    const workspaceNext = $("setup-workspace-next") as HTMLButtonElement;
    const themeBack = $("setup-theme-back") as HTMLButtonElement;
    const themeNext = $("setup-theme-next") as HTMLButtonElement;
    const updatesBack = $("setup-updates-back") as HTMLButtonElement;
    const updatesNext = $("setup-updates-next") as HTMLButtonElement;
    const doneBtn = $("setup-done-btn") as HTMLButtonElement;
    const autoUpdates = $("setup-auto-updates") as HTMLInputElement;
    const updateChannel = $("setup-update-channel") as HTMLSelectElement;
    const workspaceButtons = document.querySelectorAll<HTMLButtonElement>(
      ".setup-wizard-mode-btn",
    );
    const themeButtons = document.querySelectorAll<HTMLButtonElement>(
      ".setup-wizard-theme-btn",
    );

    function goTo(step: number): void {
      showStep(step);
    }

    function setWorkspaceSelection(mode: WorkspaceMode): void {
      selectedWorkspace = mode;
      workspaceButtons.forEach((btn) => {
        const active = btn.dataset.workspaceValue === mode;
        btn.classList.toggle("setup-wizard-choice-btn--active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
    }

    function setThemeSelection(theme: ThemePreference): void {
      selectedTheme = theme;
      themeButtons.forEach((btn) => {
        const active = btn.dataset.themeValue === theme;
        btn.classList.toggle("setup-wizard-choice-btn--active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      applyTheme(theme);
    }

    function cleanup(): void {
      overlay.hidden = true;
      if (card) releaseFocusTrap(card);
      welcomeNext.removeEventListener("click", onWelcomeNext);
      welcomeSkip.removeEventListener("click", onWelcomeSkip);
      workspaceBack.removeEventListener("click", onWorkspaceBack);
      workspaceNext.removeEventListener("click", onWorkspaceNext);
      themeBack.removeEventListener("click", onThemeBack);
      themeNext.removeEventListener("click", onThemeNext);
      updatesBack.removeEventListener("click", onUpdatesBack);
      updatesNext.removeEventListener("click", onUpdatesNext);
      doneBtn.removeEventListener("click", onDone);
      autoUpdates.removeEventListener("change", onAutoUpdatesChange);
      updateChannel.removeEventListener("change", onUpdateChannelChange);
      workspaceButtons.forEach((btn) =>
        btn.removeEventListener("click", onWorkspaceSelect),
      );
      themeButtons.forEach((btn) => btn.removeEventListener("click", onTheme));
    }

    function onWorkspaceSelect(this: HTMLButtonElement): void {
      const selected =
        this.dataset.workspaceValue === "power" ? "power" : "basic";
      setWorkspaceSelection(selected);
    }

    function onTheme(this: HTMLButtonElement): void {
      const selected = this.dataset.themeValue;
      if (
        selected === "dark" ||
        selected === "light" ||
        selected === "system"
      ) {
        setThemeSelection(selected);
      }
    }

    function onAutoUpdatesChange(): void {
      selectedAutoUpdates = autoUpdates.checked;
    }

    function onUpdateChannelChange(): void {
      if (updateChannel.value === "beta") {
        selectedChannel = "beta";
      } else if (updateChannel.value === "auto") {
        selectedChannel = "auto";
      } else {
        selectedChannel = "stable";
      }
    }

    function onWelcomeNext(): void {
      goTo(1);
    }

    function onWelcomeSkip(): void {
      cleanup();
      resolve(null);
    }

    function onWorkspaceBack(): void {
      goTo(0);
    }

    function onWorkspaceNext(): void {
      goTo(2);
    }

    function onThemeBack(): void {
      goTo(1);
    }

    function onThemeNext(): void {
      goTo(3);
    }

    function onUpdatesBack(): void {
      goTo(2);
    }

    function onUpdatesNext(): void {
      goTo(4);
    }

    function onDone(): void {
      const result: SetupWizardResult = {
        workspaceMode: selectedWorkspace,
        theme: selectedTheme,
        autoCheckUpdates: selectedAutoUpdates,
        updateChannel: selectedChannel,
      };
      cleanup();
      resolve(result);
    }

    setWorkspaceSelection(selectedWorkspace);
    setThemeSelection(selectedTheme);
    autoUpdates.checked = selectedAutoUpdates;
    updateChannel.value = selectedChannel;
    goTo(0);

    welcomeNext.addEventListener("click", onWelcomeNext);
    welcomeSkip.addEventListener("click", onWelcomeSkip);
    workspaceBack.addEventListener("click", onWorkspaceBack);
    workspaceNext.addEventListener("click", onWorkspaceNext);
    themeBack.addEventListener("click", onThemeBack);
    themeNext.addEventListener("click", onThemeNext);
    updatesBack.addEventListener("click", onUpdatesBack);
    updatesNext.addEventListener("click", onUpdatesNext);
    doneBtn.addEventListener("click", onDone);
    autoUpdates.addEventListener("change", onAutoUpdatesChange);
    updateChannel.addEventListener("change", onUpdateChannelChange);
    workspaceButtons.forEach((btn) =>
      btn.addEventListener("click", onWorkspaceSelect),
    );
    themeButtons.forEach((btn) => btn.addEventListener("click", onTheme));

    welcomeNext.focus();
  });
}
