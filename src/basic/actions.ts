import { open, confirm, save, message } from "@tauri-apps/plugin-dialog";
import { promptInput } from "../prompt-modal";
import { invoke } from "@tauri-apps/api/core";
import { state } from "../state";
import {
  log,
  getWorkspaceMode,
  getMode,
  setMode,
  renderInputs,
  triggerIconRefresh,
} from "../ui";
import { validateArchivePaths } from "../archive-rules";
import {
  runAction,
  browseArchive,
  Run7zResult,
  looksLikePasswordRequiredError,
  parseArchiveListing,
} from "../archive";
import { ensureRuntimeReady } from "../archive/runtime";
import {
  archiveExtensionForFormat,
  isPreferredCompressParent,
  fallbackCompressParent,
} from "../extract-path";
import {
  getBasicView,
  setBasicView,
  setBasicBrowsePasswordVisible,
  syncBasicToPower,
  syncBasicExtractToPower,
  syncBasicBrowsePasswordToPower,
} from "./sync";
import {
  showBasicProgress,
  hideBasicCompletion,
  showBasicCompletion,
  updateBasicPreparingState,
} from "./progress";
import { setRecentArchiveHandler } from "./recent";

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
): Promise<{ archives: string[]; others: string[] }> {
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
  } catch {
    return { archives: [], others: paths };
  }
}

function loadInputs(paths: string[]): void {
  state.inputs.length = 0;
  for (const p of paths) {
    if (state.inputs.includes(p)) continue;
    if (state.inputs.length >= 4096) break;
    state.inputs.push(p);
  }
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

  const { archives, others } = await partitionByArchive(paths);
  if (!isBasicPreparationCurrent(preparation)) return;
  const allArchives = others.length === 0 && archives.length > 0;
  const mixed = archives.length > 0 && others.length > 0;

  // Mixed drop: let the user choose extract-the-archives vs compress-everything.
  if (mixed) {
    const extractThem = await confirm(
      `You dropped ${archives.length} archive(s) and ${others.length} other file(s). Extract the archives?`,
      {
        title: "Mixed selection",
        okLabel: "Extract archives",
        cancelLabel: "More options",
      },
    );
    if (!isBasicPreparationCurrent(preparation)) return;
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
    const compressAll = await confirm(
      "Compress all dropped files into a new archive?",
      {
        title: "Mixed selection",
        okLabel: "Compress all",
        cancelLabel: "Cancel",
      },
    );
    if (!isBasicPreparationCurrent(preparation) || !compressAll) return;
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
  if (paths.length === 0) return;
  // Wait only for OS handoff / Power apply locks. Do not wait on
  // operationPreparing — that would deadlock behind destination/password dialogs.
  const { waitUntilIncomingPathsApplyingClear } =
    await import("../incoming-paths");
  await waitUntilIncomingPathsApplyingClear();
  const preparation = beginBasicPreparation();
  if (!preparation) return;
  try {
    await handleBasicDropOnce(paths, preparation);
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
      "Operation failed",
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
      "Operation failed",
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

  const output = await save({
    title: "Choose output archive",
    defaultPath,
  });

  if (
    !output ||
    !isBasicPreparationCurrent(preparation) ||
    formatSelect?.value !== format
  ) {
    return;
  }

  const basicOutputPath = document.getElementById(
    "basic-output-path",
  ) as HTMLInputElement | null;
  if (basicOutputPath) {
    basicOutputPath.value = output;
  }

  const basicArchiveName = document.getElementById(
    "basic-archive-name",
  ) as HTMLInputElement | null;
  if (basicArchiveName) {
    basicArchiveName.value = ""; // Let output path dictate name
  }

  syncBasicToPower();
  setMode("add");
  showBasicProgress("compress");
  hideBasicCompletion("compress");
  // Re-validate immediately before unlocking prep and starting the job so a
  // late input mutation cannot slip past the post-save check.
  if (!isBasicPreparationCurrent(preparation)) return;
  // Unlock prep, then enter runAction synchronously so setRunning(true) closes
  // the gap before any OS-handoff waiter can resume.
  finishBasicPreparation(preparation);
  await runAction();
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

export type PasswordCheckResult = "ok" | "wrong" | "error";

/**
 * Test a candidate password against `archive`. Distinguishes a genuinely
 * wrong password from a transport/backend failure (busy backend, runtime
 * probe failure, IPC error): those must not be reported to the user as
 * "Incorrect password", which would loop forever on an unrelated problem.
 */
export async function testArchivePassword(
  archive: string,
  password?: string,
): Promise<PasswordCheckResult> {
  if (!(await ensureRuntimeReady())) return "error";
  try {
    const args = ["t", "-spd"];
    if (password) {
      args.push(`-p${password}`);
    }
    args.push("--", archive);
    const result = await invoke<Run7zResult>("run_7z", { args });
    if (result.code > 1) {
      return looksLikePasswordRequiredError(result.stdout, result.stderr)
        ? "wrong"
        : "error";
    }
    return "ok";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Password check failed: ${msg}`, "error");
    return "error";
  }
}

/**
 * `true`/`false` when the archive's encryption state is known, `null` when
 * it could not be determined (backend/IPC failure). Callers must treat
 * `null` as "assume encrypted": silently skipping the password prompt on an
 * error would let an encrypted archive fail extraction with no explanation.
 */
export async function isArchiveEncrypted(
  archivePath: string,
): Promise<boolean | null> {
  const cached = state.browseArchiveInfoByPath.get(archivePath);
  if (cached) {
    return cached.encrypted;
  }

  if (!(await ensureRuntimeReady())) return null;
  try {
    const args = ["l", "-slt", "-spd", "--", archivePath];
    const result = await invoke<Run7zResult>("run_7z", { args });
    if (result.code > 1) {
      return looksLikePasswordRequiredError(result.stdout, result.stderr);
    }
    const info = parseArchiveListing(result.stdout);
    return info.encrypted;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Encryption check failed: ${msg}`, "error");
    return null;
  }
}

function clearBasicExtractionPasswords(): void {
  for (const id of ["basic-extract-password", "extract-password"]) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) input.value = "";
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

  // 1. Check if archive is encrypted. `null` means the check itself failed
  // (busy backend, runtime probe failure, IPC error) rather than confirming
  // the archive is plaintext; treat that the same as "encrypted" so a real
  // password requirement is never silently skipped.
  const encryptionCheck = await isArchiveEncrypted(archive);
  if (!isBasicPreparationCurrent(preparation)) return;
  if (encryptionCheck === null) {
    showBasicCompletion(
      "extract",
      false,
      "Operation failed",
      "Could not determine whether this archive is encrypted. Check the log for details and try again.",
    );
    return;
  }
  const isEncrypted = encryptionCheck;
  let password = "";

  if (isEncrypted) {
    let correctPassword = false;
    while (!correctPassword) {
      const input = await promptInput({
        title: "Password Required",
        label: "This archive is encrypted. Enter password:",
        password: true,
      });

      if (!isBasicPreparationCurrent(preparation) || input === null) {
        // User cancelled the prompt modal
        return;
      }

      // Test the password. "error" means the check itself failed (busy
      // backend, runtime probe, IPC) rather than confirming the password is
      // wrong, so it must not loop the "Incorrect password" prompt forever.
      const check = await testArchivePassword(archive, input);
      if (!isBasicPreparationCurrent(preparation)) return;
      if (check === "ok") {
        password = input;
        correctPassword = true;
      } else if (check === "wrong") {
        await message("Incorrect password. Please try again.", {
          title: "Error",
          kind: "error",
        });
        if (!isBasicPreparationCurrent(preparation)) return;
      } else {
        showBasicCompletion(
          "extract",
          false,
          "Operation failed",
          "Could not verify the archive password. Check the log for details and try again.",
        );
        return;
      }
    }
  }

  // 2. Open the folder picker before copying a password into the DOM. A
  // cancelled picker must not leave a verified password resident in fields.
  const output = await open({
    title: "Choose destination folder",
    directory: true,
  });

  if (
    !output ||
    typeof output !== "string" ||
    !isBasicPreparationCurrent(preparation)
  ) {
    return;
  }

  // 3. Populate the fields only for the immediate extraction run. The normal
  // run cleanup clears both fields when the operation finishes.
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

  const basicExtractPath = document.getElementById(
    "basic-extract-path",
  ) as HTMLInputElement | null;
  if (basicExtractPath) {
    basicExtractPath.value = output;
  }

  syncBasicExtractToPower();
  setMode("extract");
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
    await handleBasicExtractActionOnce(preparation);
  } finally {
    clearBasicExtractionPasswords();
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
      btn.setAttribute("aria-label", "Hide password");
    } else {
      btn.textContent = "Hide";
    }
    btn.setAttribute("aria-pressed", "true");
  } else {
    input.type = "password";
    if (isIconOnly) {
      const icon = btn.querySelector<HTMLElement>("[data-lucide]");
      icon?.setAttribute("data-lucide", "eye");
      btn.setAttribute("aria-label", "Show password");
    } else {
      btn.textContent = "Show";
    }
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
