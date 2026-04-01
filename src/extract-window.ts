import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

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
  if (sep <= 0) return filePath;
  return filePath.slice(0, sep);
}

function setButtons(showCancel: boolean, showClose: boolean): void {
  $("cancel-btn").hidden = !showCancel;
  $("close-btn").hidden = !showClose;
}

function stopProgressAt(widthPercent: number, error: boolean): void {
  const fill = $("progress-fill");
  fill.classList.toggle("extract-progress-fill--error", error);
  fill.style.animation = "none";
  fill.style.marginLeft = "0";
  fill.style.width = `${widthPercent}%`;
}

function startIndeterminateProgress(): void {
  const fill = $("progress-fill");
  fill.classList.remove("extract-progress-fill--error");
  fill.style.animation = "";
  fill.style.marginLeft = "";
  fill.style.width = "";
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
  const closeBtn = $("close-btn") as HTMLButtonElement;
  let cancelRequested = false;
  let operationFinished = false;

  const finish = (status: string, progressPercent: number, asError = false) => {
    operationFinished = true;
    $("extract-status").textContent = status;
    stopProgressAt(progressPercent, asError);
    setButtons(false, true);
    cancelBtn.disabled = false;
    closeBtn.disabled = false;
  };

  const showError = (detail: string) => {
    $("extract-error").hidden = false;
    $("error-detail").textContent = detail;
    finish("Failed", 100, true);
  };

  cancelBtn.addEventListener("click", async () => {
    if (operationFinished) return;
    cancelRequested = true;
    cancelBtn.disabled = true;
    closeBtn.disabled = true;
    $("extract-status").textContent = "Cancelling...";
    try {
      await invoke("cancel_7z");
    } catch {}
  });

  closeBtn.addEventListener("click", async () => {
    await closeWindowSafely(appWindow);
  });

  startIndeterminateProgress();
  setButtons(true, false);
  const paths = await invoke<string[]>("get_extract_paths");
  const archivePath = paths[0];

  if (!archivePath) {
    $("extract-status").textContent = "No archive specified.";
    stopProgressAt(0, false);
    setButtons(false, true);
    operationFinished = true;
    return;
  }

  const destination = parentDir(archivePath);

  $("archive-name").textContent = basename(archivePath);
  $("archive-name").title = archivePath;
  $("extract-dest").textContent = destination;
  $("extract-dest").title = destination;
  $("extract-status").textContent = "Extracting...";
  $("extract-error").hidden = true;

  try {
    await invoke("probe_7z");
  } catch (err) {
    showError(
      `7-Zip binary not found.\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const args = ["x", `-o${destination}`, "-aoa", archivePath];

  try {
    const result = await invoke<Run7zResult>("run_7z", { args });

    if (cancelRequested) {
      finish("Cancelled", 100);
      return;
    }

    if (result.code !== 0 && result.code !== 1) {
      const detail = result.stderr?.trim() || `Exit code ${result.code}`;
      showError(detail);
      return;
    }

    let status = "Done";
    if (result.code === 1) {
      status = "Done (with warnings)";
    }

    finish(status, 100);
  } catch (err) {
    if (cancelRequested) {
      finish("Cancelled", 100);
      return;
    }
    showError(err instanceof Error ? err.message : String(err));
  }
}

run().catch((err) => {
  document.body.textContent = `Fatal: ${err instanceof Error ? err.message : String(err)}`;
});
