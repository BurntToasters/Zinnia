import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { deriveExtractDestinationPath } from "./extract-path";

interface Run7zResult {
  stdout: string;
  stderr: string;
  code: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

function basename(filePath: string): string {
  const sep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return sep >= 0 ? filePath.slice(sep + 1) : filePath;
}

function parentDir(filePath: string): string {
  const sep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (sep < 0) return ".";
  if (sep === 0) return "/";
  const parent = filePath.slice(0, sep);
  // Windows drive root: "C:" → "C:\\"
  if (parent.length === 2 && parent[1] === ":") return parent + "\\";
  return parent;
}

function setButtons(
  showCancel: boolean,
  showOpenDestination: boolean,
  showClose: boolean,
): void {
  $("cancel-btn").hidden = !showCancel;
  $("open-destination-btn").hidden = !showOpenDestination;
  $("close-btn").hidden = !showClose;
}

function stopProgressAt(widthPercent: number, error: boolean): void {
  const fill = $("progress-fill");
  fill.classList.toggle("extract-progress-fill--error", error);
  fill.style.animation = "none";
  fill.style.marginLeft = "0";
  fill.style.width = `${widthPercent}%`;
  const bar = document.getElementById("extract-progress");
  if (bar) {
    bar.setAttribute("aria-valuenow", String(widthPercent));
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
  }
}

function startIndeterminateProgress(): void {
  const fill = $("progress-fill");
  fill.classList.remove("extract-progress-fill--error");
  fill.style.animation = "";
  fill.style.marginLeft = "";
  fill.style.width = "";
}

function setDeterminateProgress(widthPercent: number): void {
  const clamped = Math.max(0, Math.min(100, widthPercent));
  const fill = $("progress-fill");
  fill.classList.remove("extract-progress-fill--error");
  fill.style.animation = "none";
  fill.style.marginLeft = "0";
  fill.style.width = `${clamped}%`;
  const bar = document.getElementById("extract-progress");
  if (bar) {
    bar.setAttribute("aria-valuenow", String(clamped));
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
  }
}

async function countArchiveEntries(archivePath: string): Promise<number> {
  try {
    const result = await invoke<Run7zResult>("run_7z", {
      args: ["l", "-ba", "--", archivePath],
    });
    if (result.code !== 0) return 0;
    return result.stdout.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

async function closeWindowSafely(
  appWindow: ReturnType<typeof getCurrentWebviewWindow>,
): Promise<void> {
  try {
    await appWindow.close();
  } catch {
    try {
      await appWindow.destroy();
    } catch {}
  }
}

async function run() {
  const appWindow = getCurrentWebviewWindow();
  const cancelBtn = $("cancel-btn") as HTMLButtonElement;
  const openDestinationBtn = $("open-destination-btn") as HTMLButtonElement;
  const closeBtn = $("close-btn") as HTMLButtonElement;
  let cancelRequested = false;
  let operationFinished = false;
  let destination = "";

  const finish = (
    status: string,
    progressPercent: number,
    asError = false,
    allowOpenDestination = true,
    asCancelled = false,
  ) => {
    operationFinished = true;
    $("extract-status").textContent = status;
    const h1 = document.querySelector<HTMLHeadingElement>("h1");
    if (h1) {
      h1.textContent = asError
        ? "Extraction failed"
        : asCancelled
          ? "Extraction cancelled"
          : "Extraction complete";
    }
    document.title = asError
      ? "Zinnia — Failed"
      : asCancelled
        ? "Zinnia — Cancelled"
        : "Zinnia — Done";
    stopProgressAt(progressPercent, asError);
    setButtons(false, !asError && allowOpenDestination, true);
    cancelBtn.disabled = false;
    openDestinationBtn.disabled = false;
    closeBtn.disabled = false;
    if (!asError && allowOpenDestination) {
      openDestinationBtn.focus();
    } else {
      closeBtn.focus();
    }
  };

  const showError = (detail: string) => {
    $("extract-error").hidden = false;
    $("error-detail").textContent = detail;
    finish("Failed", 100, true, false);
  };

  cancelBtn.addEventListener("click", async () => {
    if (operationFinished) return;
    cancelRequested = true;
    cancelBtn.disabled = true;
    openDestinationBtn.disabled = true;
    closeBtn.disabled = true;
    $("extract-status").textContent = "Cancelling...";
    try {
      await invoke("cancel_7z");
    } catch {}
  });

  closeBtn.addEventListener("click", async () => {
    await closeWindowSafely(appWindow);
  });

  openDestinationBtn.addEventListener("click", async () => {
    if (!destination) return;
    openDestinationBtn.disabled = true;
    try {
      await invoke("open_path", { path: destination });
      $("extract-status").textContent = "Destination opened.";
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      $("extract-error").hidden = false;
      const titleEl = $("extract-error").querySelector<HTMLElement>(
        ".extract-error-title",
      );
      if (titleEl) titleEl.textContent = "Could not open destination";
      $("error-detail").textContent = detail;
      $("extract-status").textContent = "Done (open destination failed)";
    } finally {
      openDestinationBtn.disabled = false;
    }
  });

  startIndeterminateProgress();
  setButtons(true, false, false);
  const paths = await invoke<string[]>("get_extract_paths");
  const archivePath = paths[0];

  if (!archivePath) {
    $("extract-status").textContent = "No archive specified.";
    stopProgressAt(0, false);
    setButtons(false, false, true);
    operationFinished = true;
    return;
  }

  destination =
    deriveExtractDestinationPath(archivePath) || parentDir(archivePath);

  $("archive-name").textContent = basename(archivePath);
  $("archive-name").title = archivePath;
  $("extract-dest").textContent = destination;
  $("extract-dest").title = destination;
  $("extract-status").textContent = "Scanning archive...";
  $("extract-error").hidden = true;

  try {
    await invoke("probe_7z");
  } catch (err) {
    showError(
      `7-Zip binary not found.\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const totalEntries = await countArchiveEntries(archivePath);
  let processedEntries = 0;

  const unlistenProgress = await listen<string>("7z-progress", (event) => {
    const chunk = typeof event.payload === "string" ? event.payload : "";
    if (!chunk) return;
    const lines = chunk.split(/\r?\n/);
    let changed = false;
    for (const line of lines) {
      if (/^- \S/.test(line)) {
        processedEntries++;
        changed = true;
      }
    }
    if (changed && totalEntries > 0) {
      const pct = Math.min(
        99,
        Math.floor((processedEntries / totalEntries) * 100),
      );
      setDeterminateProgress(pct);
    }
  });

  $("extract-status").textContent = "Extracting...";
  if (totalEntries > 0) {
    setDeterminateProgress(0);
  }

  const args = [
    "x",
    `-o${destination}`,
    "-aoa",
    "-y",
    "-bb1",
    "--",
    archivePath,
  ];

  try {
    const result = await invoke<Run7zResult>("run_7z", { args });
    unlistenProgress();

    if (cancelRequested) {
      finish("Cancelled", 100, false, false, true);
      return;
    }

    if (result.code !== 0 && result.code !== 1) {
      const detail = result.stderr?.trim() || `Exit code ${result.code}`;
      showError(detail);
      return;
    }

    if (result.code === 1) {
      const detail =
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        "Exit code 1 (no detail available).";
      const titleEl = $("extract-error").querySelector<HTMLElement>(
        ".extract-error-title",
      );
      if (titleEl) titleEl.textContent = "Warnings";
      $("error-detail").textContent = detail;
      $("extract-error").hidden = false;
      finish("Done (with warnings)", 100);
    } else {
      finish("Done", 100);
      setTimeout(() => {
        if (!cancelRequested) {
          void closeWindowSafely(appWindow);
        }
      }, 1200);
    }
  } catch (err) {
    unlistenProgress();
    if (cancelRequested) {
      finish("Cancelled", 100, false, false, true);
      return;
    }
    showError(err instanceof Error ? err.message : String(err));
  }
}

run().catch((err) => {
  document.body.textContent = `Fatal: ${err instanceof Error ? err.message : String(err)}`;
});
