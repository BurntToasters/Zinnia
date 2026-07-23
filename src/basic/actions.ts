import { open, confirm, save, message } from "@tauri-apps/plugin-dialog";
import { promptInput } from "../prompt-modal";
import { invoke } from "@tauri-apps/api/core";
import { state } from "../state";
import { log, getWorkspaceMode, setMode, renderInputs } from "../ui";
import { validateArchivePaths } from "../archive-rules";
import {
  runAction,
  browseArchive,
  Run7zResult,
  looksLikePasswordRequiredError,
  parseArchiveListing,
} from "../archive";
import {
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
    if (!state.inputs.includes(p)) state.inputs.push(p);
  }
}

let basicDropPending = false;
let basicActionPending = false;

async function handleBasicDropOnce(paths: string[]): Promise<void> {
  if (paths.length === 0 || state.running) return;

  const { archives, others } = await partitionByArchive(paths);
  if (state.running) return;
  const allArchives = others.length === 0 && archives.length > 0;
  const mixed = archives.length > 0 && others.length > 0;

  // Mixed drop: let the user choose extract-the-archives vs compress-everything.
  if (mixed) {
    const extractThem = await confirm(
      `You dropped ${archives.length} archive(s) and ${others.length} other file(s). Extract the archives, or compress everything into a new archive?`,
      {
        title: "Mixed selection",
        okLabel: "Extract archives",
        cancelLabel: "Compress all",
      },
    );
    if (state.running) return;
    if (extractThem) {
      loadInputs(archives);
      setMode("extract");
      setBasicView("extract");
      renderInputs();
    } else {
      loadInputs(paths);
      setMode("add");
      setBasicView("compress");
      renderInputs();
    }
    return;
  }

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
  if (basicDropPending || state.running) return;
  basicDropPending = true;
  try {
    await handleBasicDropOnce(paths);
  } finally {
    basicDropPending = false;
  }
}

async function handleBasicCompressActionOnce(): Promise<void> {
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

  // Prefer saving next to the source, but not under Start Menu / Program Files
  // (common for .lnk shortcuts) where staging dirs get Access Denied.
  let defaultPath = `Archive.${format}`;
  if (state.inputs[0]) {
    const parent = parentDirForPath(state.inputs[0]);
    if (parent && isPreferredCompressParent(parent)) {
      const sep = state.inputs[0].includes("\\") ? "\\" : "/";
      defaultPath = parent.endsWith(sep)
        ? `${parent}Archive.${format}`
        : `${parent}${sep}Archive.${format}`;
    } else {
      const fallback = fallbackCompressParent(state.inputs[0]);
      if (fallback) {
        const sep = fallback.includes("\\") ? "\\" : "/";
        defaultPath = `${fallback}${sep}Archive.${format}`;
      }
    }
  }

  const output = await save({
    title: "Choose output archive",
    defaultPath,
  });

  if (!output) {
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
  await runAction();
}

export async function handleBasicCompressAction(): Promise<void> {
  if (basicActionPending || state.running) return;
  basicActionPending = true;
  try {
    await handleBasicCompressActionOnce();
  } finally {
    basicActionPending = false;
  }
}

export async function testArchivePassword(
  archive: string,
  password?: string,
): Promise<boolean> {
  try {
    const args = ["t", "-spd"];
    if (password) {
      args.push(`-p${password}`);
    }
    args.push("--", archive);
    const result = await invoke<Run7zResult>("run_7z", { args });
    if (result.code > 1) {
      return !looksLikePasswordRequiredError(result.stdout, result.stderr);
    }
    return true;
  } catch {
    return false;
  }
}

export async function isArchiveEncrypted(
  archivePath: string,
): Promise<boolean> {
  const cached = state.browseArchiveInfoByPath.get(archivePath);
  if (cached) {
    return cached.encrypted;
  }

  try {
    const args = ["l", "-slt", "-spd", "--", archivePath];
    const result = await invoke<Run7zResult>("run_7z", { args });
    if (result.code > 1) {
      return looksLikePasswordRequiredError(result.stdout, result.stderr);
    }
    const info = parseArchiveListing(result.stdout);
    return info.encrypted;
  } catch {
    return false;
  }
}

async function handleBasicExtractActionOnce(): Promise<void> {
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

  // 1. Check if archive is encrypted
  const isEncrypted = await isArchiveEncrypted(archive);
  let password = "";

  if (isEncrypted) {
    let correctPassword = false;
    while (!correctPassword) {
      const input = await promptInput({
        title: "Password Required",
        label: "This archive is encrypted. Enter password:",
        password: true,
      });

      if (input === null) {
        // User cancelled the prompt modal
        return;
      }

      // Test the password
      const ok = await testArchivePassword(archive, input);
      if (ok) {
        password = input;
        correctPassword = true;
      } else {
        await message("Incorrect password. Please try again.", {
          title: "Error",
          kind: "error",
        });
      }
    }
  }

  // 2. Open the folder picker before copying a password into the DOM. A
  // cancelled picker must not leave a verified password resident in fields.
  const output = await open({
    title: "Choose destination folder",
    directory: true,
  });

  if (!output || typeof output !== "string") {
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
  await runAction();
}

export async function handleBasicExtractAction(): Promise<void> {
  if (basicActionPending || state.running) return;
  basicActionPending = true;
  try {
    await handleBasicExtractActionOnce();
  } finally {
    basicActionPending = false;
  }
}

export function togglePasswordVisibility(inputId: string, btnId: string): void {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (!input || !btn) return;

  const isPassword = input.type === "password";
  if (isPassword) {
    input.type = "text";
    btn.textContent = "Hide";
    btn.setAttribute("aria-pressed", "true");
  } else {
    input.type = "password";
    btn.textContent = "Show";
    btn.setAttribute("aria-pressed", "false");
  }
}

export function handleBasicDragDrop(type: string, paths?: string[]): void {
  if (getWorkspaceMode() !== "basic") return;

  // Highlight the home dropzone when it's showing, otherwise the whole
  // workspace so drops are discoverable from every basic view.
  const dropzone = document.getElementById("basic-dropzone");
  const workspace = document.getElementById("basic-workspace");
  const target = getBasicView() === "home" && dropzone ? dropzone : workspace;
  if (!target) return;

  if (state.running) {
    dropzone?.classList.remove("is-drag-over");
    workspace?.classList.remove("is-drag-over");
    return;
  }

  if (type === "enter" || type === "over") {
    target.classList.add("is-drag-over");
  } else if (type === "leave") {
    dropzone?.classList.remove("is-drag-over");
    workspace?.classList.remove("is-drag-over");
  } else if (type === "drop") {
    dropzone?.classList.remove("is-drag-over");
    workspace?.classList.remove("is-drag-over");
    if (paths && paths.length > 0) {
      void handleBasicDrop(paths);
    }
  }
}

export { parentDirForPath };

setRecentArchiveHandler((path) => {
  void handleBasicDrop([path]);
});
