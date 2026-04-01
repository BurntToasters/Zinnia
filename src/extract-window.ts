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

async function run() {
  const appWindow = getCurrentWebviewWindow();
  const paths = await invoke<string[]>("get_extract_paths");
  const archivePath = paths[0];

  if (!archivePath) {
    $("extract-status").textContent = "No archive specified.";
    $("cancel-btn").hidden = true;
    $("close-btn").hidden = false;
    return;
  }

  const destination = parentDir(archivePath);

  $("archive-name").textContent = basename(archivePath);
  $("archive-name").title = archivePath;
  $("extract-dest").textContent = destination;
  $("extract-dest").title = destination;
  $("extract-status").textContent = "Extracting...";

  $("cancel-btn").addEventListener("click", async () => {
    try {
      await invoke("cancel_7z");
    } catch (_) {}
    await appWindow.close();
  });

  $("close-btn").addEventListener("click", async () => {
    await appWindow.close();
  });

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

    if (result.code > 1) {
      const detail = result.stderr?.trim() || `Exit code ${result.code}`;
      showError(detail);
      return;
    }

    if (result.code === 1) {
      $("extract-status").textContent = "Done (with warnings)";
    }

    const fill = $("progress-fill");
    fill.style.width = "100%";
    $("extract-status").textContent = "Done";

    setTimeout(async () => {
      await appWindow.close();
    }, 800);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

function showError(detail: string) {
  $("extract-status").textContent = "Failed";
  $("extract-error").hidden = false;
  $("error-detail").textContent = detail;
  $("cancel-btn").hidden = true;
  $("close-btn").hidden = false;
  const fill = $("progress-fill");
  fill.classList.add("extract-progress-fill--error");
}

run().catch((err) => {
  document.body.textContent = `Fatal: ${err instanceof Error ? err.message : String(err)}`;
});
