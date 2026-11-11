import { open, confirm, save } from "@tauri-apps/plugin-dialog";
import { promptInput } from "../prompt-modal";
import { invoke } from "@tauri-apps/api/core";
import { clearBrowseCache, state } from "../state";
import {
  log,
  getWorkspaceMode,
  getMode,
  setMode,
  renderInputs,
  setStatus,
  triggerIconRefresh,
} from "../ui";
import { MAX_ARCHIVE_PATHS, validateArchivePaths } from "../archive-rules";
import {
  runAction,
  browseArchive,
  looksLikePasswordRequiredError,
  parseArchiveListing,
} from "../archive";
import { runActionAfterNativeSave } from "../archive/ops";
import { browsedArchivePasswordFor } from "../archive/inspection";
import {
  clearPasswordFields,
  ensureRuntimeReady,
  invokeGuardedRun7z,
} from "../archive/runtime";
import {
  archiveExtensionForFormat,
  isPreferredCompressParent,
  fallbackCompressParent,
} from "../extract-path";
import {
  getBasicView,
  setBasicView,
  setBasicBrowsePasswordVisible,
  syncBasicBeforeRun,
  syncBasicBrowsePasswordToPower,
} from "./sync";
import {
  showBasicProgress,
  hideBasicCompletion,
  showBasicCompletion,
  updateBasicPreparingState,
} from "./progress";
import { setRecentArchiveHandler } from "./recent";
import { showToast } from "../toast";
import { waitUntilIncomingPathsApplyingClear } from "../incoming-paths";
import { confirmWithE2eQueue, takeE2eDialogResult } from "../e2e-dialog";
import { userFacingBackendError } from "../error-hints";

async function confirmBasicDrop(
  text: string,
  options: Parameters<typeof confirm>[1],
): Promise<boolean | null> {
  try {
    return await confirmWithE2eQueue(() => confirm(text, options));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Could not open Basic confirmation dialog: ${msg}`, "error");
    setStatus("Could not open confirmation dialog", 3000);
    return null;
  }
}

function parentDirForPath(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (sep < 0) return path;
  if (sep === 0) return "/";
  const parent = path.slice(0, sep);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent;
}

export async function openPathWithFeedback(path: string): Promise<void> {
  if (!path) return;
  try {
    await invoke("open_path", { path });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to open path: ${msg}`, "error");
  }
}

export async function runBasicBrowseArchive(): Promise<void> {
  syncBasicBrowsePasswordToPower();
  await browseArchive();
  const powerField = document.getElementById("browse-password-field");
  if (powerField && !powerField.hidden) {
    setBasicBrowsePasswordVisible(true);
  }
}

export async function partitionByArchive(
  paths: string[],
): Promise<{ archives: string[]; others: string[] } | null> {
  try {
    const results = await validateArchivePaths(paths);
    const validByPath = new Map(results.map((r) => [r.path, r.valid]));
    const archives: string[] = [];
    const others: string[] = [];
    for (const p of paths) {
      if (validByPath.get(p)) archives.push(p);
      else others.push(p);
    }
    return { archives, others };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Archive probe failed while sorting drop: ${msg}`, "error");
    return null;
  }
}

/**
 * Deduplicate and cap a Basic selection before archive probing. This keeps an
 * oversized all-archive drop from being classified as regular files.
 */
function limitBasicInputPaths(paths: string[]): {
  paths: string[];
  overLimit: number;
} {
  const uniquePaths = new Set<string>();
  const acceptedPaths: string[] = [];
  let overLimit = 0;
  for (const path of paths) {
    if (uniquePaths.has(path)) continue;
    uniquePaths.add(path);
    if (acceptedPaths.length >= MAX_ARCHIVE_PATHS) {
      overLimit += 1;
      continue;
    }
    acceptedPaths.push(path);
  }
  return { paths: acceptedPaths, overLimit };
}

function showBasicInputLimitToast(overLimit: number): void {
  if (overLimit === 0) return;
  showToast(
    `Selected the first 4,096 items; ${overLimit} more were not added.`,
    "error",
    5000,
  );
}

/** Replace Basic inputs and return paths rejected only because of the hard cap. */
export function replaceBasicInputs(paths: string[]): number {
  const limited = limitBasicInputPaths(paths);
  state.inputs.splice(0, state.inputs.length, ...limited.paths);
  return limited.overLimit;
}

function loadInputs(paths: string[]): void {
  replaceBasicInputs(paths);
}

export interface BasicPreparation {
  generation: number;
  inputs: string[];
  mode: ReturnType<typeof getMode>;
  view: ReturnType<typeof getBasicView>;
}

let basicPreparationGeneration = 0;

export function isBasicInteractionLocked(): boolean {
  return (
    state.running || state.operationPreparing || state.incomingPathsApplying
  );
}

export function beginBasicPreparation(): BasicPreparation | null {
  if (isBasicInteractionLocked() || getWorkspaceMode() !== "basic") return null;
  const preparation: BasicPreparation = {
    generation: ++basicPreparationGeneration,
    inputs: [...state.inputs],
    mode: getMode(),
    view: getBasicView(),
  };
  updateBasicPreparingState(true);
  return preparation;
}

export function isBasicPreparationCurrent(
  preparation: BasicPreparation,
): boolean {
  return (
    state.operationPreparing &&
    !state.running &&
    preparation.generation === basicPreparationGeneration &&
    getWorkspaceMode() === "basic" &&
    getBasicView() === preparation.view &&
    getMode() === preparation.mode &&
    preparation.inputs.length === state.inputs.length &&
    preparation.inputs.every((path, index) => path === state.inputs[index])
  );
}

export function finishBasicPreparation(preparation: BasicPreparation): void {
  if (preparation.generation !== basicPreparationGeneration) return;
  updateBasicPreparingState(false);
}

async function handleBasicDropOnce(
  paths: string[],
  preparation: BasicPreparation,
): Promise<void> {
  if (paths.length === 0) return;

  const partitioned = await partitionByArchive(paths);
  if (!isBasicPreparationCurrent(preparation)) return;
  if (!partitioned) {
    finishBasicPreparation(preparation);
    showToast(
      "Could not detect archive types for the dropped files. Try again.",
      "error",
      5000,
    );
    return;
  }
  const { archives, others } = partitioned;
  const allArchives = others.length === 0 && archives.length > 0;
  const mixed = archives.length > 0 && others.length > 0;

  // Mixed drop: let the user choose extract-the-archives vs compress-everything.
  if (mixed) {
    const extractThem = await confirmBasicDrop(
      `You dropped ${archives.length} archive(s) and ${others.length} other file(s). Extract the archives?`,
      {
        title: "Mixed selection",
        okLabel: "Extract archives",
        cancelLabel: "More options",
      },
    );
    if (!isBasicPreparationCurrent(preparation) || extractThem === null) return;
    if (extractThem) {
      finishBasicPreparation(preparation);
      loadInputs(archives);
      setMode("extract");
      setBasicView("extract");
      renderInputs();
      return;
    }

    // A dismissed native confirmation is indistinguishable from its cancel
    // button. Require a second affirmative choice before compressing so
    // dismissal can never start an unintended operation.
    const compressAll = await confirmBasicDrop(
      "Compress all dropped files into a new archive?",
      {
        title: "Mixed selection",
        okLabel: "Compress all",
        cancelLabel: "Cancel",
      },
    );
    if (
      !isBasicPreparationCurrent(preparation) ||
      compressAll === null ||
      !compressAll
    )
      return;
    finishBasicPreparation(preparation);
    loadInputs(paths);
    setMode("add");
    setBasicView("compress");
    renderInputs();
    return;
  }

  finishBasicPreparation(preparation);
  loadInputs(paths);

  if (allArchives) {
    if (paths.length === 1) {
      setMode("browse");
      setBasicView("browse");
      renderInputs();
      void runBasicBrowseArchive();
    } else {
      setMode("extract");
      setBasicView("extract");
      renderInputs();
    }
  } else {
    setMode("add");
    setBasicView("compress");
    renderInputs();
  }
}

export async function handleBasicDrop(paths: string[]): Promise<void> {
  const limited = limitBasicInputPaths(paths);
  if (limited.paths.length === 0) return;
  // Wait only for OS handoff / Power apply locks. Do not wait on
  // operationPreparing; that would deadlock behind destination/password dialogs.
  await waitUntilIncomingPathsApplyingClear();
  const preparation = beginBasicPreparation();
  if (!preparation) {
    showToast(
      "An operation is already running. Drop the files again in a moment.",
      "error",
      4000,
    );
    return;
  }
  showBasicInputLimitToast(limited.overLimit);
  try {
    await handleBasicDropOnce(limited.paths, preparation);
  } finally {
    finishBasicPreparation(preparation);
  }
}

async function handleBasicCompressActionOnce(
  preparation: BasicPreparation,
): Promise<void> {
  if (state.inputs.length === 0) {
    showBasicCompletion(
      "compress",
      false,
      "Check your choices",
      "Add at least one input.",
    );
    return;
  }

  const formatEarly = (
    document.getElementById("basic-format") as HTMLSelectElement | null
  )?.value?.toLowerCase();
  if (
    state.inputs.length > 1 &&
    (formatEarly === "gzip" || formatEarly === "bzip2" || formatEarly === "xz")
  ) {
    showBasicCompletion(
      "compress",
      false,
      "Check your choices",
      `${(formatEarly || "format").toUpperCase()} accepts exactly one input. Pick one file, or use 7z/ZIP/TAR.`,
    );
    return;
  }

  const formatSelect = document.getElementById(
    "basic-format",
  ) as HTMLSelectElement | null;
  const format = formatSelect?.value ?? "7z";
  const outputExtension = archiveExtensionForFormat(format);

  // Prefer saving next to the source, but not under Start Menu / Program Files
  // (common for .lnk shortcuts) where staging dirs get Access Denied.
  let defaultPath = `Archive.${outputExtension}`;
  if (state.inputs[0]) {
    const parent = parentDirForPath(state.inputs[0]);
    if (parent && isPreferredCompressParent(parent)) {
      const sep = state.inputs[0].includes("\\") ? "\\" : "/";
      defaultPath = parent.endsWith(sep)
        ? `${parent}Archive.${outputExtension}`
        : `${parent}${sep}Archive.${outputExtension}`;
    } else {
      const fallback = fallbackCompressParent(state.inputs[0]);
      if (fallback) {
        const sep = fallback.includes("\\") ? "\\" : "/";
        defaultPath = `${fallback}${sep}Archive.${outputExtension}`;
      }
    }
  }

  // Respect a destination already entered in Basic. Open the save dialog only
  // when the field is empty; typed paths must work without native UI.
  const basicOutputPath = document.getElementById(
    "basic-output-path",
  ) as HTMLInputElement | null;
  let output: string | null = basicOutputPath?.value ?? null;
  // The native save dialog already asked about overwriting the chosen file.
  let chosenByNativeSave = false;
  if (!output) {
    const queued = takeE2eDialogResult();
    const queuedPath =
      queued && typeof queued.result === "string" ? queued.result : null;
    try {
      output =
        queuedPath ??
        (await save({
          title: "Choose output archive",
          defaultPath,
        }));
      chosenByNativeSave = Boolean(output);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Could not open the save-archive dialog: ${msg}`, "error");
      showBasicCompletion(
        "compress",
        false,
        "Operation failed",
        "Could not open the save dialog. Check the log and try again.",
      );
      return;
    }
  }

  if (
    !output ||
    !isBasicPreparationCurrent(preparation) ||
    formatSelect?.value !== format
  ) {
    return;
  }

  if (basicOutputPath) {
    basicOutputPath.value = output;
  }

  const basicArchiveName = document.getElementById(
    "basic-archive-name",
  ) as HTMLInputElement | null;
  if (basicArchiveName) {
    basicArchiveName.value = ""; // Let output path dictate name
  }

  setMode("add");
  syncBasicBeforeRun();
  showBasicProgress("compress");
  hideBasicCompletion("compress");
  // Re-validate immediately before unlocking prep and starting the job so a
  // late input mutation cannot slip past the post-save check.
  if (!isBasicPreparationCurrent(preparation)) return;
  // Unlock prep, then enter runAction synchronously so setRunning(true) closes
  // the gap before any OS-handoff waiter can resume.
  finishBasicPreparation(preparation);
  if (chosenByNativeSave) {
    await runActionAfterNativeSave();
  } else {
    await runAction();
  }
}

export async function handleBasicCompressAction(): Promise<void> {
  const preparation = beginBasicPreparation();
  if (!preparation) return;
  try {
    await handleBasicCompressActionOnce(preparation);
  } finally {
    finishBasicPreparation(preparation);
  }
}

/**
 * `true`/`false` when the archive's encryption state is known, `null` when
 * it could not be determined (truncated listing, probe or IPC failure). For
 * `null`, callers skip the upfront password prompt and rely on the password
 * prompt that runs when 7-Zip reports that a password is required.
 */
export async function isArchiveEncrypted(
  archivePath: string,
): Promise<boolean | null> {
  const cached = state.browseArchiveInfoByPath.get(archivePath);
  const cachedIdentity = state.browseArchiveIdentityByPath.get(archivePath);
  if (cached && cachedIdentity) {
    try {
      const [current] = await validateArchivePaths([archivePath], true);
      if (current?.valid && current.identity === cachedIdentity) {
        return cached.encrypted;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Could not validate cached archive identity: ${msg}`, "error");
    }
    clearBrowseCache(archivePath);
  } else if (cached || cachedIdentity) {
    // A partial cache entry can never establish that the file at this path is
    // still the file whose listing supplied the encryption state.
    clearBrowseCache(archivePath);
  }

  if (!(await ensureRuntimeReady())) return null;
  try {
    const args = ["l", "-slt", "-spd", "--", archivePath];
    const result = await invokeGuardedRun7z(args);
    if (result.code > 1) {
      return looksLikePasswordRequiredError(result.stdout, result.stderr);
    }
    if (result.stdout_truncated || result.stderr_truncated) {
      return null;
    }
    const info = parseArchiveListing(result.stdout);
    return info.encrypted;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Encryption check failed: ${msg}`, "error");
    return null;
  }
}

async function handleBasicExtractActionOnce(
  preparation: BasicPreparation,
): Promise<void> {
  const archive = state.inputs[0];
  if (!archive) {
    showBasicCompletion(
      "extract",
      false,
      "Operation failed",
      "Select an archive to extract.",
    );
    return;
  }

  // 1. Check if archive is encrypted. `null` means the check could not decide
  // (busy backend, truncated listing, IPC error). Do not prompt upfront then:
  // the run prompts when 7-Zip reports that a password is required, so a
  // plaintext archive is never blocked by a failed check.
  const encryptionCheck = await isArchiveEncrypted(archive);
  if (!isBasicPreparationCurrent(preparation)) return;
  if (encryptionCheck === null) {
    const [validation] = await validateArchivePaths([archive]);
    if (!isBasicPreparationCurrent(preparation)) return;
    if (!validation?.valid) {
      showBasicCompletion(
        "extract",
        false,
        "Check your choices",
        userFacingBackendError(
          validation?.reason?.trim() ??
            "This archive path is not supported for extraction.",
        ),
      );
      return;
    }
    log(
      "Could not determine whether this archive is encrypted; a password prompt appears only if one is needed.",
      "debug",
    );
  }
  // Reuse the password that opened this archive in Browse, if it still matches.
  let password = (await browsedArchivePasswordFor(archive)) ?? "";
  if (!isBasicPreparationCurrent(preparation)) return;

  if (encryptionCheck === true && !password) {
    while (!password) {
      const input = await promptInput({
        title: "Password Required",
        label: "This archive is encrypted. Enter password:",
        password: true,
      });

      if (!isBasicPreparationCurrent(preparation) || input === null) {
        return;
      }
      password = input;
    }
  }

  // 2. Respect a destination already entered in Basic. Open the picker only
  // when the field is empty; typed paths must not unexpectedly trigger a
  // native dialog that blocks automation and keyboard-only workflows.
  const basicExtractPath = document.getElementById(
    "basic-extract-path",
  ) as HTMLInputElement | null;
  let output: string | null = basicExtractPath?.value ?? null;
  if (!output) {
    const queued = takeE2eDialogResult();
    const queuedPath =
      queued && typeof queued.result === "string" ? queued.result : null;
    try {
      if (queuedPath) {
        output = queuedPath;
      } else {
        const selected = await open({
          title: "Choose destination folder",
          directory: true,
        });
        output = typeof selected === "string" ? selected : null;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Could not open the destination-folder dialog: ${msg}`, "error");
      showBasicCompletion(
        "extract",
        false,
        "Operation failed",
        "Could not open the folder dialog. Check the log and try again.",
      );
      return;
    }
  }

  if (!output || !isBasicPreparationCurrent(preparation)) {
    return;
  }

  // 3. Populate the fields only for the immediate extraction run. A password
  // typed into the field stays when nothing was prompted (unknown encryption
  // state), and the run cleanup clears both fields once 7-Zip has started.
  if (password) {
    const basicPasswordInput = document.getElementById(
      "basic-extract-password",
    ) as HTMLInputElement | null;
    if (basicPasswordInput) {
      basicPasswordInput.value = password;
    }
    const powerPasswordInput = document.getElementById(
      "extract-password",
    ) as HTMLInputElement | null;
    if (powerPasswordInput) {
      powerPasswordInput.value = password;
    }
  }

  if (basicExtractPath) {
    basicExtractPath.value = output;
  }

  setMode("extract");
  syncBasicBeforeRun();
  showBasicProgress("extract");
  hideBasicCompletion("extract");
  // Re-validate immediately before unlocking prep and starting the job so a
  // late input mutation cannot apply a verified password to another archive.
  if (!isBasicPreparationCurrent(preparation)) return;
  // Unlock prep, then enter runAction synchronously so setRunning(true) closes
  // the gap before any OS-handoff waiter can resume.
  finishBasicPreparation(preparation);
  await runAction();
}

export async function handleBasicExtractAction(): Promise<void> {
  const preparation = beginBasicPreparation();
  if (!preparation) return;
  try {
    // runAction clears the password fields once 7-Zip has started. Clearing
    // here would also erase the password on pre-run errors. Only an unexpected
    // rejection clears them, since no run can be trusted to have done so.
    await handleBasicExtractActionOnce(preparation);
  } catch (err) {
    clearPasswordFields();
    throw err;
  } finally {
    finishBasicPreparation(preparation);
  }
}

export function togglePasswordVisibility(inputId: string, btnId: string): void {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (!input || !btn) return;

  const isPassword = input.type === "password";
  const isIconOnly = btn.classList.contains("basic-password-toggle--icon");
  if (isPassword) {
    input.type = "text";
    if (isIconOnly) {
      const icon = btn.querySelector<HTMLElement>("[data-lucide]");
      icon?.setAttribute("data-lucide", "eye-off");
    } else {
      btn.textContent = "Hide";
    }
    btn.setAttribute("aria-label", "Hide password");
    btn.setAttribute("aria-pressed", "true");
  } else {
    input.type = "password";
    if (isIconOnly) {
      const icon = btn.querySelector<HTMLElement>("[data-lucide]");
      icon?.setAttribute("data-lucide", "eye");
    } else {
      btn.textContent = "Show";
    }
    btn.setAttribute("aria-label", "Show password");
    btn.setAttribute("aria-pressed", "false");
  }
  if (isIconOnly) triggerIconRefresh();
}

export function handleBasicDragDrop(type: string, paths?: string[]): void {
  if (getWorkspaceMode() !== "basic") return;

  // Highlight the home dropzone when it's showing, otherwise the whole
  // workspace so drops are discoverable from every basic view.
  const dropzone = document.getElementById("basic-dropzone");
  const workspace = document.getElementById("basic-workspace");
  const target = getBasicView() === "home" && dropzone ? dropzone : workspace;
  if (!target) return;

  if (type === "drop") {
    dropzone?.classList.remove("is-drag-over");
    workspace?.classList.remove("is-drag-over");
    if (paths && paths.length > 0) {
      // Queue behind OS handoffs instead of silently discarding.
      void handleBasicDrop(paths);
    }
    return;
  }

  if (isBasicInteractionLocked()) {
    dropzone?.classList.remove("is-drag-over");
    workspace?.classList.remove("is-drag-over");
    return;
  }

  if (type === "enter" || type === "over") {
    target.classList.add("is-drag-over");
  } else if (type === "leave") {
    dropzone?.classList.remove("is-drag-over");
    workspace?.classList.remove("is-drag-over");
  }
}

export { parentDirForPath };

setRecentArchiveHandler((path) => {
  void handleBasicDrop([path]);
});
