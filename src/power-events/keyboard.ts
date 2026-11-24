import { $, isImeComposing, isKeyHandled, markKeyHandled } from "../utils";
import { state } from "../state";
import { closeSettingsModal, toggleSettingsModal } from "../settings";
import {
  browseArchive,
  runAction,
  closeCommandPreviewModal,
  closeSelectiveExtractModal,
} from "../archive";
import { closeLicensesModal } from "../licenses";
import { getMode, getWorkspaceMode } from "../ui";
import { getBasicView, syncBasicBeforeRun, type BasicView } from "../basic";
import { isBlockingModalOpen, isEditableTarget } from "../power-helpers";
import { openShortcutsModal, closeShortcutsModal } from "../power-shortcuts";

const BASIC_PRIMARY_RUN_BUTTON_IDS: Partial<Record<BasicView, string>> = {
  compress: "basic-run-compress",
  extract: "basic-run-extract",
  browse: "basic-browse-extract-all",
};

function runBasicPrimaryAction(): void {
  const buttonId = BASIC_PRIMARY_RUN_BUTTON_IDS[getBasicView()];
  if (buttonId) document.getElementById(buttonId)?.click();
}

export function wireGlobalKeyboardEvents(): void {
  document.addEventListener("keydown", (e) => {
    // A toast or the Recent menu already consumed this key.
    if (isKeyHandled(e)) return;
    if (!$("setup-wizard-overlay").hidden) {
      if (e.key === "Escape") {
        markKeyHandled(e);
        e.preventDefault();
      }
      return;
    }
    if (isBlockingModalOpen()) {
      if (e.key === "Escape") {
        return;
      }
      if (
        e.key === "?" ||
        (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ||
        (e.key === "," && (e.ctrlKey || e.metaKey))
      ) {
        return;
      }
    }
    if (e.key === "," && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // Licenses can be stacked above Settings. Do not toggle the lower sheet
      // while the topmost modal owns focus.
      if (!$("licenses-overlay").hidden) return;
      toggleSettingsModal();
      return;
    }
    if (e.key === "Escape") {
      // Licenses may be nested over Settings in Basic mode; always dismiss the
      // visually topmost sheet first. Each close marks the event so the Basic
      // handler does not also navigate Home.
      if (!$("licenses-overlay").hidden) {
        markKeyHandled(e);
        closeLicensesModal();
        return;
      }
      if (!$("settings-overlay").hidden) {
        markKeyHandled(e);
        closeSettingsModal();
        return;
      }
      if (!$("selective-overlay").hidden) {
        markKeyHandled(e);
        closeSelectiveExtractModal();
        return;
      }
      if (!$("command-preview-overlay").hidden) {
        markKeyHandled(e);
        closeCommandPreviewModal();
        return;
      }
      if (!$("shortcuts-overlay").hidden) {
        markKeyHandled(e);
        closeShortcutsModal();
        return;
      }
    }
    if (e.key === "?" && !isEditableTarget(e.target)) {
      if (
        !$("setup-wizard-overlay").hidden ||
        !$("settings-overlay").hidden ||
        !$("selective-overlay").hidden ||
        !$("command-preview-overlay").hidden ||
        !$("licenses-overlay").hidden ||
        !$("input-modal-overlay").hidden ||
        !$("convert-overlay").hidden
      )
        return;
      e.preventDefault();
      openShortcutsModal();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      if (isImeComposing(e)) return;
      if (
        !$("setup-wizard-overlay").hidden ||
        !$("settings-overlay").hidden ||
        !$("input-modal-overlay").hidden ||
        !$("licenses-overlay").hidden ||
        !$("selective-overlay").hidden ||
        !$("command-preview-overlay").hidden ||
        !$("shortcuts-overlay").hidden ||
        !$("convert-overlay").hidden
      )
        return;
      // The backend runs at most one 7z operation at a time. Basic
      // preparation (password probes, encryption checks) and incoming-path
      // application both run with `state.running === false`, so this global
      // shortcut must check them too or it can start a second, conflicting
      // operation while one of those is in flight.
      if (
        state.running ||
        state.operationPreparing ||
        state.incomingPathsApplying
      )
        return;
      e.preventDefault();
      if (getWorkspaceMode() === "basic") {
        runBasicPrimaryAction();
        return;
      }
      syncBasicBeforeRun();
      if (getMode() === "browse") void browseArchive();
      else void runAction();
    }
  });
}
