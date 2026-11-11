import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { confirmWithE2eQueue, takeE2eDialogResult } from "../e2e-dialog";
import { $, parseThreads, releaseFocusTrap, trapFocus } from "../utils";
import { state } from "../state";
import { getDefaultThreads } from "../window-events";
import {
  devLog,
  getMode,
  hideProgress,
  log,
  setRunning,
  setStatus,
} from "../ui";
import {
  acquireIncomingPathLock,
  isIncomingPathBusy,
  releaseIncomingPathLock,
} from "../incoming-paths";
import { ensureArchivePaths } from "../archive-rules";
import {
  getCompressionSecuritySupport,
  normalizeCompressionSecurityOptions,
  validateCompressionSecurityOptions,
} from "../compression-security";
import { showToast } from "../toast";
import { SAFE_EXTRACT_OVERWRITE_MODE } from "../extract-policy";
import { debugLog, debugLogCommand, isDebugEnabled } from "../debug-mode";
import { validateArchiveOutputExtension } from "./args";
import { browseArchive, browsedArchivePasswordFor } from "./inspection";
import { getCachedArchiveInfo } from "./browse-selective-helpers";
import { sanitizeCommandArgsForPreview } from "./preview";
import {
  clearPasswordFields,
  ensureRuntimeReady,
  invokeGuardedRun7z,
  logCommandResult,
  runWithPasswordRetry,
  truncateForDialog,
  showOperationError,
  withLiveProgress,
} from "./runtime";
import {
  userFacing7zErrorDetail,
  userFacingBackendError,
} from "../error-hints";
import { basename } from "../path-display";
import type { ArchiveInfo } from "../browse-model";

let mutationDialogOpen = false;

type MutationDialogLease<T> = {
  value: T;
  release: () => void;
};

async function runMutationDialog<T>(
  dialog: () => Promise<T>,
): Promise<MutationDialogLease<T> | null> {
  if (mutationDialogOpen || isIncomingPathBusy()) return null;
  mutationDialogOpen = true;
  let locked = false;
  let leased = false;
  const release = () => {
    if (locked) {
      locked = false;
      releaseIncomingPathLock();
    }
    mutationDialogOpen = false;
  };
  try {
    await acquireIncomingPathLock();
    locked = true;
    const mode = getMode();
    const inputs = JSON.stringify(state.inputs);
    const value = await dialog();
    if (
      state.running ||
      state.operationPreparing ||
      getMode() !== mode ||
      JSON.stringify(state.inputs) !== inputs
    ) {
      return null;
    }
    leased = true;
    return { value, release };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Could not open archive mutation dialog: ${msg}`, "error");
    setStatus("Could not open the file dialog", 3000);
    return null;
  } finally {
    if (!leased) release();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function addFilesToArchive(): Promise<void> {
  if (state.running) return;
  const archive = state.inputs[0];
  if (!archive) {
    showToast("Open an archive first to add files to it.", "info");
    return;
  }
  if (!/\.(?:7z|zip|tar)$/i.test(archive)) {
    showToast(
      "This archive format cannot be updated in place. Convert it to 7z, ZIP, or TAR, or create a new archive.",
      "info",
      0,
    );
    return;
  }

  const picked = await runMutationDialog(() => {
    const queued = takeE2eDialogResult();
    return queued
      ? Promise.resolve(queued.result)
      : open({ multiple: true, directory: false });
  });
  if (!picked) return;
  const selection = picked.value;
  const files = Array.isArray(selection)
    ? selection
    : selection
      ? [selection]
      : [];
  if (files.length === 0) {
    picked.release();
    return;
  }

  let refreshAfterRun = false;
  // Password fields are cleared only once 7-Zip has started for this run.
  let sevenZipStarted = false;
  state.cancelRequested = false;
  state.batchCancelled = false;
  setRunning(true);
  picked.release();
  try {
    if (!(await ensureRuntimeReady())) return;
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return;
    }
    const [validation] = await ensureArchivePaths(
      [archive],
      "extract",
      undefined,
      true,
    );
    if (!validation?.identity) {
      throw new Error("Could not capture a stable archive identity.");
    }
    const outputSelectionToken = await invoke<string>(
      "archive_output_selection_token",
      { path: archive },
    );
    if (!outputSelectionToken || outputSelectionToken === "absent") {
      throw new Error(
        "Archive output disappeared after it was selected; choose the current file again.",
      );
    }
    const threads = parseThreads(
      $<HTMLInputElement>("threads").value,
      getDefaultThreads(),
    );
    // -bsp1 turns on the percent stream that withLiveProgress reads.
    const args = ["u", "-sse", "-snl", "-snh", "-spd", "-bsp1"];
    const archivePassword = $<HTMLInputElement>("browse-password").value;
    if (archivePassword) args.push(`-p${archivePassword}`);
    const zipDest = archive.toLowerCase().endsWith(".zip");
    const cached = state.browseArchiveInfoByPath.get(archive);
    if (
      zipDest &&
      (cached?.zipCrypto || cached?.method?.toLowerCase().includes("zipcrypto"))
    ) {
      throw new Error(
        "This ZIP still has ZipCrypto members. Convert it to a new AES-256 ZIP instead of adding files in place.",
      );
    }
    if (archivePassword && zipDest) args.push("-mem=AES256");
    if (zipDest) args.push("-mcu=on");
    if (threads) args.push(`-mmt=${threads}`);
    args.push(archive, "--", ...files);
    setStatus("Adding files");
    devLog(`7z ${sanitizeCommandArgsForPreview(args).join(" ")}`);
    debugLogCommand(args);
    const result = await withLiveProgress(() => {
      sevenZipStarted = true;
      return runWithPasswordRetry(
        args,
        true,
        "Add files",
        outputSelectionToken,
      );
    });
    if (state.cancelRequested && result.code !== 0) {
      setStatus("Cancelled", 2000);
      return;
    }
    logCommandResult(result.stdout, result.stderr, result.code);

    if (result.code !== 0) {
      setStatus(
        "Error",
        3000,
        userFacing7zErrorDetail(result.stdout, result.stderr),
      );
      if (isDebugEnabled()) {
        debugLog(`Add files failed with exit code ${result.code}.`);
      }
      showOperationError(result.code, result.stdout, result.stderr);
      return;
    }

    setStatus("Done", 2000);
    if (isDebugEnabled()) {
      debugLog(`Added ${files.length} file(s) to archive.`);
    }
    showToast(
      `Added ${files.length} file${files.length === 1 ? "" : "s"} to the archive.`,
      "success",
    );
    refreshAfterRun = true;
  } catch (err) {
    const raw = errorMessage(err);
    log(`Error: ${raw}`, "error");
    if (isDebugEnabled()) debugLog(`Add files threw: ${raw}`);
    const msg = userFacingBackendError(raw);
    setStatus("Error", 3000, msg);
    showToast(
      `Add-files operation failed: ${truncateForDialog(msg, 1000)}`,
      "error",
      0,
    );
  } finally {
    setRunning(false);
    hideProgress();
    // A successful add keeps the Browse password for the listing that follows.
    if (sevenZipStarted && !refreshAfterRun) clearPasswordFields();
  }
  if (refreshAfterRun) {
    await browseArchive();
    clearPasswordFields();
  }
}

// ── Convert dialog ────────────────────────────────────────────────────────

type ConvertChoice = {
  format: string;
  password: string;
  encryptHeaders: boolean;
  splitSize: string;
  storeTimestamps: boolean;
  dest: string;
};

const CONVERT_EXTENSIONS: Record<string, string> = {
  "7z": "7z",
  zip: "zip",
  tar: "tar",
  gzip: "gz",
  bzip2: "bz2",
  xz: "xz",
};

const ARCHIVE_SUFFIX_PATTERN =
  /\.(?:tar\.(?:gz|bz2|xz)|tgz|tbz2|txz|7z|zip|tar|gz|bz2|xz)$/i;
const SPLIT_SIZE_PATTERN = /^\d+(?:b|k|m|g)?$/i;
const SPLIT_SIZE_PARTS = /^(\d+)(b|k|m|g)?$/i;
const SPLIT_UNIT_BYTES: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
};
const MIN_SPLIT_SIZE_BYTES = 1024 * 1024;
const UNENCRYPTED_COPY_TITLE = "Write an unencrypted copy?";

/** Save name the dialog proposes: the source stem plus the new extension. */
function convertDefaultName(archive: string, format: string): string {
  const base = basename(archive);
  const stem = base.replace(ARCHIVE_SUFFIX_PATTERN, "") || base;
  return `${stem}.${CONVERT_EXTENSIONS[format] ?? format}`;
}

/** Same directory as the source archive, so the save dialog opens there. */
function siblingPath(archive: string, name: string): string {
  const separator = Math.max(
    archive.lastIndexOf("/"),
    archive.lastIndexOf("\\"),
  );
  return separator < 0 ? name : `${archive.slice(0, separator + 1)}${name}`;
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").toLowerCase();
  return normalize(a) === normalize(b);
}

/**
 * Same rules as the Add-tab split control, read from the Convert dialog. It
 * returns the error instead of throwing, so a bad value stays a dialog message.
 */
function readConvertSplitSize(
  choice: string,
  custom: string,
): { size: string } | { error: string } {
  if (!choice) return { size: "" };
  const raw = choice === "custom" ? custom.trim().toLowerCase() : choice;
  if (!raw) return { size: "" };
  if (!SPLIT_SIZE_PATTERN.test(raw)) {
    return {
      error: `Invalid split size "${raw}". Use a number with optional b/k/m/g, e.g. 100m.`,
    };
  }
  const parts = SPLIT_SIZE_PARTS.exec(raw);
  const bytes = parts
    ? Number(parts[1]) *
      (SPLIT_UNIT_BYTES[(parts[2] ?? "b").toLowerCase()] ?? 1)
    : 0;
  if (!Number.isSafeInteger(bytes) || bytes < MIN_SPLIT_SIZE_BYTES) {
    return { error: "Split size must be at least 1 MiB." };
  }
  return { size: raw };
}

/**
 * Convert takes its switches from the dialog and fixed defaults only. Reading
 * the Add-tab level, method or dictionary would apply controls the user
 * cannot see while converting in Browse mode.
 */
function convertCompressSwitches(format: string): string[] {
  const switches = [`-t${format}`, "-mx=5"];
  if (format === "zip") switches.push("-mcu=on");
  return switches;
}

function resetConvertPasswordField(): void {
  const input = document.getElementById(
    "convert-password",
  ) as HTMLInputElement | null;
  const toggle = document.getElementById(
    "convert-toggle-password",
  ) as HTMLButtonElement | null;
  if (input) {
    input.value = "";
    input.type = "password";
  }
  if (toggle) {
    toggle.textContent = "Show";
    toggle.setAttribute("aria-label", "Show password");
    toggle.setAttribute("aria-pressed", "false");
  }
}

async function chooseConvertDestination(
  archive: string,
  name: string,
): Promise<string | null> {
  const queued = takeE2eDialogResult();
  if (queued) {
    return typeof queued.result === "string" ? queued.result : null;
  }
  return save({
    title: "Convert archive to",
    defaultPath: siblingPath(archive, name),
  });
}

/**
 * Shows the Convert dialog and resolves with every option the run needs, or
 * null on cancel. Validation and the save dialog happen inside the dialog, so
 * an error keeps the dialog open and the typed password in place.
 */
function askConvertOptions(
  archive: string,
  sourceEncrypted: boolean,
): Promise<ConvertChoice | null> {
  const overlay = $<HTMLElement>("convert-overlay");
  const modal = overlay.querySelector<HTMLElement>(".modal");
  if (!modal) throw new Error("Convert dialog markup is missing.");
  const sourceLine = $<HTMLElement>("convert-source");
  const formatSelect = $<HTMLSelectElement>("convert-format");
  const passwordField = $<HTMLElement>("convert-password-field");
  const passwordInput = $<HTMLInputElement>("convert-password");
  const passwordToggle = $<HTMLButtonElement>("convert-toggle-password");
  const encryptField = $<HTMLElement>("convert-encrypt-field");
  const encryptCheckbox = $<HTMLInputElement>("convert-encrypt-headers");
  const splitSelect = $<HTMLSelectElement>("convert-split-size");
  const splitCustomField = $<HTMLElement>("convert-split-custom-field");
  const splitCustom = $<HTMLInputElement>("convert-split-custom");
  const timestampsCheckbox = $<HTMLInputElement>("convert-store-timestamps");
  const outputLine = $<HTMLElement>("convert-output-name");
  const errorLine = $<HTMLElement>("convert-error");
  const submitButton = $<HTMLButtonElement>("convert-submit");
  const cancelButton = $<HTMLButtonElement>("convert-cancel");
  const closeButton = $<HTMLButtonElement>("convert-close");

  return new Promise((resolve) => {
    const controller = new AbortController();
    const { signal } = controller;
    let settled = false;
    let busy = false;

    const finish = (value: ConvertChoice | null) => {
      if (settled) return;
      settled = true;
      controller.abort();
      overlay.hidden = true;
      releaseFocusTrap(modal);
      // Cancel abandons the typed password. A run start clears it later.
      if (value === null) resetConvertPasswordField();
      submitButton.disabled = false;
      document.getElementById("browse-convert")?.focus();
      resolve(value);
    };

    const showError = (message: string) => {
      errorLine.textContent = message;
      errorLine.hidden = false;
    };
    const clearError = () => {
      errorLine.textContent = "";
      errorLine.hidden = true;
    };

    const refreshFields = () => {
      const format = formatSelect.value;
      const support = getCompressionSecuritySupport(format);
      passwordField.hidden = !support.password;
      encryptField.hidden = !support.encryptHeaders;
      if (!support.encryptHeaders) encryptCheckbox.checked = false;
      splitCustomField.hidden = splitSelect.value !== "custom";
      const encrypted = support.password && passwordInput.value.length > 0;
      const name = convertDefaultName(archive, format);
      const encryption = encrypted ? "encrypted" : "not encrypted";
      const warning =
        sourceEncrypted && !encrypted
          ? " The source is encrypted, so this copy will open without a password."
          : "";
      outputLine.textContent = `Saves as ${name}, ${encryption}.${warning}`;
    };

    const submit = async () => {
      if (busy || settled) return;
      busy = true;
      submitButton.disabled = true;
      clearError();
      try {
        const format = formatSelect.value;
        const securityError = validateCompressionSecurityOptions(
          format,
          passwordInput.value,
          encryptCheckbox.checked,
        );
        if (securityError) {
          showError(securityError);
          return;
        }
        const normalized = normalizeCompressionSecurityOptions(
          format,
          passwordInput.value,
          encryptCheckbox.checked,
        );
        const split = readConvertSplitSize(
          splitSelect.value,
          splitCustom.value,
        );
        if ("error" in split) {
          showError(split.error);
          return;
        }
        const splitSize = split.size;
        if (sourceEncrypted && !normalized.password) {
          const proceed = await confirmWithE2eQueue(
            () =>
              confirm(
                `${basename(archive)} is encrypted, but the new archive will have no password. Anyone who can open the copy can read its contents.`,
                {
                  title: UNENCRYPTED_COPY_TITLE,
                  kind: "warning",
                  okLabel: "Write unencrypted copy",
                  cancelLabel: "Cancel",
                },
              ),
            UNENCRYPTED_COPY_TITLE,
          );
          if (settled || !proceed) return;
        }
        const dest = await chooseConvertDestination(
          archive,
          convertDefaultName(archive, format),
        );
        if (settled || !dest) return;
        const extensionError = validateArchiveOutputExtension(dest, format);
        if (extensionError) {
          showError(extensionError);
          return;
        }
        if (samePath(dest, archive)) {
          showError(
            "Choose a different file name. Converting would overwrite the source archive.",
          );
          return;
        }
        finish({
          format,
          password: normalized.password,
          encryptHeaders: normalized.encryptHeaders,
          splitSize,
          storeTimestamps: timestampsCheckbox.checked,
          dest,
        });
      } catch (err) {
        showError(`Could not convert: ${errorMessage(err)}`);
      } finally {
        busy = false;
        if (!settled) submitButton.disabled = false;
      }
    };

    // Reset the choices for this run. The password is kept until a run starts
    // or the dialog is cancelled, so a pre-run error does not erase it.
    formatSelect.value = "7z";
    encryptCheckbox.checked = false;
    timestampsCheckbox.checked = false;
    splitSelect.value = "";
    splitCustom.value = "";
    clearError();
    sourceLine.textContent = sourceEncrypted
      ? `${basename(archive)} is encrypted.`
      : basename(archive);
    refreshFields();
    overlay.hidden = false;
    trapFocus(modal);
    formatSelect.focus();

    formatSelect.addEventListener(
      "change",
      () => {
        clearError();
        refreshFields();
      },
      { signal },
    );
    passwordInput.addEventListener("input", refreshFields, { signal });
    splitSelect.addEventListener("change", refreshFields, { signal });
    passwordToggle.addEventListener(
      "click",
      () => {
        const showing = passwordInput.type === "text";
        passwordInput.type = showing ? "password" : "text";
        passwordToggle.textContent = showing ? "Show" : "Hide";
        passwordToggle.setAttribute(
          "aria-label",
          showing ? "Show password" : "Hide password",
        );
        passwordToggle.setAttribute("aria-pressed", String(!showing));
      },
      { signal },
    );
    submitButton.addEventListener("click", () => void submit(), { signal });
    cancelButton.addEventListener("click", () => finish(null), { signal });
    closeButton.addEventListener("click", () => finish(null), { signal });
    // Capture phase keeps app shortcuts (Ctrl+Enter runs, ? and , open
    // sheets) from firing behind the dialog. Tab stays with the focus trap.
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Tab") return;
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        }
      },
      { capture: true, signal },
    );
  });
}

/** Source archive password: typed in Browse, else remembered from listing, else Extract. */
async function sourcePasswordFor(archive: string): Promise<string> {
  const typed = $<HTMLInputElement>("browse-password").value;
  if (typed) return typed;
  const remembered = await browsedArchivePasswordFor(archive);
  if (remembered) return remembered;
  return $<HTMLInputElement>("extract-password").value;
}

/**
 * Listing answers whether the source is encrypted. A cached listing is reused
 * only for the same file identity. A failed or cancelled listing returns null.
 */
async function sourceArchiveInfo(
  archive: string,
  identity: string,
): Promise<ArchiveInfo | null> {
  const cached = getCachedArchiveInfo(archive);
  if (cached && state.browseArchiveIdentityByPath.get(archive) === identity) {
    return cached;
  }
  return browseArchive(identity);
}

export async function convertArchive(): Promise<void> {
  if (state.running) return;
  const archive = state.inputs[0];
  if (!archive) {
    showToast("Open an archive first to convert it.", "info");
    return;
  }

  let sourceEncrypted: boolean;
  try {
    const [validation] = await ensureArchivePaths(
      [archive],
      "extract",
      undefined,
      true,
    );
    if (!validation?.identity) {
      throw new Error("Could not capture a stable archive identity.");
    }
    const info = await sourceArchiveInfo(archive, validation.identity);
    if (!info) {
      // Browse has already said why. A cancel is not an error to repeat.
      if (!state.cancelRequested) {
        showToast(
          "Convert could not read the archive listing, so it cannot check whether the archive is encrypted. Archives whose listing is over 64 MiB cannot be converted yet.",
          "error",
          0,
        );
      }
      return;
    }
    sourceEncrypted = info.encrypted;
  } catch (err) {
    const raw = errorMessage(err);
    log(`Conversion setup failed: ${raw}`, "error");
    const msg = userFacingBackendError(raw);
    showToast(
      `Conversion setup failed: ${truncateForDialog(msg, 1000)}`,
      "error",
      0,
    );
    return;
  }

  const picked = await runMutationDialog(() =>
    askConvertOptions(archive, sourceEncrypted),
  );
  if (!picked) return;
  const choice = picked.value;
  if (!choice) {
    picked.release();
    return;
  }
  const { format, dest } = choice;

  // Snapshot before the long extract so a file created in that window cannot
  // be mistaken for an intentional overwrite target at recompress time.
  let outputSelectionToken: string;
  try {
    outputSelectionToken = await invoke<string>(
      "archive_output_selection_token",
      {
        path: dest,
      },
    );
  } catch (err) {
    picked.release();
    const raw = errorMessage(err);
    log(`Conversion setup failed: ${raw}`, "error");
    const msg = userFacingBackendError(raw);
    showToast(
      `Conversion setup failed: ${truncateForDialog(msg, 1000)}`,
      "error",
      0,
    );
    return;
  }

  state.cancelRequested = false;
  state.batchCancelled = false;
  setRunning(true);
  picked.release();
  let tempDir: string | null = null;
  // Password fields are cleared only once 7-Zip has started for this run.
  let sevenZipStarted = false;
  try {
    if (!(await ensureRuntimeReady())) return;
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return;
    }
    const [validation] = await ensureArchivePaths(
      [archive],
      "extract",
      undefined,
      true,
    );
    if (!validation?.identity) {
      throw new Error("Could not capture a stable archive identity.");
    }
    // Reserve a managed leaf without creating it. The extraction backend can
    // then publish the completed stage by rename instead of copying into an
    // already-created empty conversion directory.
    tempDir = await invoke<string>("reserve_temp_extract_path");

    const password = await sourcePasswordFor(archive);

    setStatus("Extracting for conversion");
    const extractArgs = [
      "x",
      `-o${tempDir}`,
      SAFE_EXTRACT_OVERWRITE_MODE,
      "-bb1",
      "-bsp1",
      "-spd",
    ];
    if (password) extractArgs.push(`-p${password}`);
    extractArgs.push("--", archive);
    debugLogCommand(extractArgs);
    const extract = await withLiveProgress(() => {
      sevenZipStarted = true;
      return runWithPasswordRetry(
        extractArgs,
        true,
        "Extract",
        validation.identity,
      );
    });
    if (state.cancelRequested) {
      setStatus("Cancelled", 2000);
      return;
    }
    logCommandResult(extract.stdout, extract.stderr, extract.code);
    if (extract.code !== 0) {
      setStatus(
        "Error",
        3000,
        userFacing7zErrorDetail(extract.stdout, extract.stderr),
      );
      if (isDebugEnabled()) {
        debugLog(`Convert extract failed with exit code ${extract.code}.`);
      }
      showOperationError(extract.code, extract.stdout, extract.stderr);
      return;
    }

    setStatus("Recompressing");
    const compress = [
      "a",
      "-sse",
      "-snl",
      "-snh",
      "-spd",
      "-bsp1",
      ...convertCompressSwitches(format),
    ];
    if (choice.password) compress.push(`-p${choice.password}`);
    if (choice.password && format === "zip") compress.push("-mem=AES256");
    if (choice.encryptHeaders) compress.push("-mhe=on");
    if (choice.storeTimestamps) compress.push("-mtc=on", "-mta=on");
    if (choice.splitSize) compress.push(`-v${choice.splitSize}`);
    // List children explicitly (includes dotfiles). `tempDir/*` drops `.*`.
    const children = await invoke<string[]>("list_managed_temp_children", {
      path: tempDir,
    });
    if (state.cancelRequested || state.batchCancelled) {
      setStatus("Cancelled", 2000);
      return;
    }
    if (children.length === 0) {
      throw new Error("Conversion extract produced no files to recompress.");
    }
    if (["gzip", "bzip2", "xz"].includes(format) && children.length !== 1) {
      throw new Error(
        "GZIP, BZIP2, and XZ can contain exactly one file. Convert this archive to TAR or 7z instead.",
      );
    }
    if (state.cancelRequested || state.batchCancelled) {
      setStatus("Cancelled", 2000);
      return;
    }
    compress.push(dest, "--", ...children);

    debugLogCommand(compress);
    const result = await withLiveProgress(() => {
      sevenZipStarted = true;
      return invokeGuardedRun7z(compress, outputSelectionToken, archive);
    });
    if (state.cancelRequested && result.code !== 0) {
      setStatus("Cancelled", 2000);
      return;
    }
    logCommandResult(result.stdout, result.stderr, result.code);
    if (result.code !== 0) {
      setStatus(
        "Error",
        3000,
        userFacing7zErrorDetail(result.stdout, result.stderr),
      );
      if (isDebugEnabled()) {
        debugLog(`Convert failed with exit code ${result.code}.`);
      }
      showOperationError(result.code, result.stdout, result.stderr);
      return;
    }

    setStatus("Done", 2000);
    if (isDebugEnabled()) {
      debugLog(`Converted archive to ${format.toUpperCase()}.`);
    }
    showToast(`Converted archive to ${format.toUpperCase()}.`, "success");
  } catch (err) {
    const raw = errorMessage(err);
    log(`Error: ${raw}`, "error");
    if (isDebugEnabled()) debugLog(`Convert threw: ${raw}`);
    const msg = userFacingBackendError(raw);
    setStatus("Error", 3000, msg);
    showToast(`Conversion failed: ${truncateForDialog(msg, 1000)}`, "error", 0);
  } finally {
    if (tempDir) {
      try {
        await invoke("remove_managed_temp_dir", { path: tempDir });
      } catch (err) {
        devLog(`Failed to clean up temp dir: ${errorMessage(err)}`);
      }
    }
    if (sevenZipStarted) {
      clearPasswordFields();
      resetConvertPasswordField();
    }
    setRunning(false);
    hideProgress();
  }
}
