import { $ } from "../utils";
import { promptInput } from "../prompt-modal";
import { state } from "../state";
import { syncSettingsSecurityControlsForFormat } from "../settings";
import { setStatus, persistSettingsImmediately } from "../ui";
import {
  updateCompressionOptionsForFormat,
  applyPreset,
  onCompressionOptionChange,
  saveCustomPreset,
  deleteCustomPreset,
  refreshPresetDropdown,
} from "../presets";
import { confirmWithE2eQueue } from "../e2e-dialog";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  deriveOutputArchivePath,
  resolveOutputArchiveAutofill,
} from "../extract-path";
import { wirePasswordToggle } from "../power-helpers";
import { showToast } from "../toast";

export function wirePresetAndCompressionEvents(): void {
  function syncOutputPath(): void {
    const outputPathInput = document.getElementById(
      "output-path",
    ) as HTMLInputElement | null;
    const archiveNameInput = document.getElementById(
      "archive-name",
    ) as HTMLInputElement | null;
    if (!outputPathInput) return;
    const format = $<HTMLSelectElement>("format").value;
    const rawName = archiveNameInput?.value;
    const customName = rawName && rawName.length > 0 ? rawName : undefined;
    const next = resolveOutputArchiveAutofill(
      outputPathInput.value,
      state.lastAutoOutputPath,
      state.inputs,
      format,
      customName,
    );
    if (next) {
      outputPathInput.value = next;
      state.lastAutoOutputPath = next;
    }
  }

  const updateDeletePresetButton = () => {
    const isCustom = $<HTMLSelectElement>("preset").value.startsWith("custom:");
    $("delete-preset").hidden = !isCustom;
  };

  refreshPresetDropdown();
  updateDeletePresetButton();

  $<HTMLSelectElement>("preset").addEventListener("change", () => {
    applyPreset($<HTMLSelectElement>("preset").value);
    updateDeletePresetButton();
  });

  $("save-preset").addEventListener("click", () => {
    void (async () => {
      const raw = await promptInput({
        title: "Save preset",
        label: "Name this preset:",
        placeholder: "e.g. My backup",
        confirmLabel: "Save",
      });
      const name = raw?.trim();
      if (!name) return;
      const previousPresets = state.currentSettings.customPresets.map(
        (preset) => ({ ...preset }),
      );
      try {
        saveCustomPreset(name);
        refreshPresetDropdown(`custom:${name}`);
        updateDeletePresetButton();
        await persistSettingsImmediately(
          state.currentSettings,
          state.settingsExtras,
        );
        setStatus(`Preset "${name}" saved`, 2000);
      } catch (err) {
        state.currentSettings.customPresets = previousPresets;
        refreshPresetDropdown("custom");
        updateDeletePresetButton();
        const detail = err instanceof Error ? err.message : String(err);
        setStatus("Error", 3000, detail);
        showToast(`Could not save preset "${name}". ${detail}`, "error", 0);
      }
    })();
  });

  $("delete-preset").addEventListener("click", () => {
    void (async () => {
      const value = $<HTMLSelectElement>("preset").value;
      if (!value.startsWith("custom:")) return;
      const name = value.slice("custom:".length);
      const confirmed = await confirmWithE2eQueue(() =>
        ask(`Delete preset "${name}"? This cannot be undone.`, {
          title: "Delete preset",
          kind: "warning",
          okLabel: "Delete preset",
          cancelLabel: "Cancel",
        }),
      );
      if (!confirmed) return;
      const previousPresets = state.currentSettings.customPresets.map(
        (preset) => ({ ...preset }),
      );
      try {
        deleteCustomPreset(name);
        refreshPresetDropdown("custom");
        updateDeletePresetButton();
        await persistSettingsImmediately(
          state.currentSettings,
          state.settingsExtras,
        );
        setStatus(`Preset "${name}" deleted`, 2000);
      } catch (err) {
        state.currentSettings.customPresets = previousPresets;
        refreshPresetDropdown(value);
        updateDeletePresetButton();
        const detail = err instanceof Error ? err.message : String(err);
        setStatus("Error", 3000, detail);
        showToast(`Could not delete preset "${name}". ${detail}`, "error", 0);
      }
    })();
  });

  $<HTMLSelectElement>("s-format").addEventListener("change", () => {
    syncSettingsSecurityControlsForFormat(
      $<HTMLSelectElement>("s-format")
        .value as typeof state.currentSettings.format,
    );
  });

  $("output-path").addEventListener("input", () => {
    const value = $<HTMLInputElement>("output-path").value;
    if (value !== (state.lastAutoOutputPath ?? "")) {
      state.lastAutoOutputPath = null;
    }
  });

  $("archive-name").addEventListener("input", () => {
    // Archive name field always drives the output path (force-update).
    const outputPathInput = $<HTMLInputElement>("output-path");
    const archiveNameInput = $<HTMLInputElement>("archive-name");
    const format = $<HTMLSelectElement>("format").value;
    const customName = archiveNameInput.value || undefined;
    const next = deriveOutputArchivePath(state.inputs, format, customName);
    if (next) {
      outputPathInput.value = next;
      state.lastAutoOutputPath = next;
    }
  });

  $<HTMLSelectElement>("format").addEventListener("change", () => {
    updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
    onCompressionOptionChange();
    syncOutputPath();
  });

  for (const id of ["level", "method", "dict", "word-size", "solid"]) {
    $(id).addEventListener("change", () => {
      if (id === "method") {
        updateCompressionOptionsForFormat($<HTMLSelectElement>("format").value);
      }
      onCompressionOptionChange();
    });
  }

  $<HTMLSelectElement>("split-size").addEventListener("change", () => {
    const isCustom = $<HTMLSelectElement>("split-size").value === "custom";
    $("split-custom-field").hidden = !isCustom;
    if (isCustom) $<HTMLInputElement>("split-custom").focus();
  });

  wirePasswordToggle("password", "toggle-password");

  wirePasswordToggle("extract-password", "toggle-extract-password");

  $("extract-path").addEventListener("input", () => {
    const value = $<HTMLInputElement>("extract-path").value;
    if (value && value !== state.lastAutoExtractDestination) {
      state.lastAutoExtractDestination = null;
    }
  });
}
