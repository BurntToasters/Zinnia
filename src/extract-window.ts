import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { deriveExtractDestinationPath } from "./extract-path";
import { describe7zError, looksLikePasswordRequiredError } from "./error-hints";
import { SAFE_EXTRACT_OVERWRITE_MODE } from "./extract-policy";
import { promptInput } from "./prompt-modal";

interface Run7zResult {
  stdout: string;
  stderr: string;
  code: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}

interface ProgressUpdate {
  percent?: number;
  filesDone?: number;
  currentFile?: string;
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

function withPassword(args: string[], password: string): string[] {
  const separator = args.indexOf("--");
  const head = separator === -1 ? args : args.slice(0, separator);
  const tail = separator === -1 ? [] : args.slice(separator);
  return [
    ...head.filter((arg) => !arg.startsWith("-p")),
    `-p${password}`,
    ...tail,
  ];
}

async function runWithPasswordRetry(args: string[]): Promise<Run7zResult> {
  let result = await invoke<Run7zResult>("run_7z", { args });
  if (
    result.code > 1 &&
    looksLikePasswordRequiredError(result.stdout ?? "", result.stderr ?? "")
  ) {
    const password = await promptInput({
      title: "Password required",
      label: "This archive is encrypted. Enter password:",
      password: true,
      confirmLabel: "Extract",
    });
    if (password) {
      result = await invoke<Run7zResult>("run_7z", {
        args: withPassword(args, password),
      });
    }
  }
  return result;
}

// Estimate remaining time from elapsed time and percent complete.
// Returns "" when there isn't enough signal yet.
export function formatEta(elapsedMs: number, percent: number): string {
  if (percent <= 0 || percent >= 100 || elapsedMs <= 0) return "";
  const totalMs = elapsedMs / (percent / 100);
  const remainingSec = Math.max(0, Math.round((totalMs - elapsedMs) / 1000));
  if (remainingSec < 1) return "";
  if (remainingSec < 60) return `~${remainingSec}s left`;
  const min = Math.floor(remainingSec / 60);
  const sec = remainingSec % 60;
  return `~${min}m ${sec.toString().padStart(2, "0")}s left`;
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

async function closeWindowSafely(): Promise<void> {
  try {
    await invoke("close_extract_window");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const errorBox = document.getElementById("extract-error");
    if (errorBox) errorBox.hidden = false;
    const title = errorBox?.querySelector<HTMLElement>(".extract-error-title");
    if (title) title.textContent = "Could not close safely";
    const detailBox = document.getElementById("error-detail");
    if (detailBox) detailBox.textContent = detail;
    const status = document.getElementById("extract-status");
    if (status) status.textContent = "Waiting for cleanup";
  }
}

async function run() {
  const appWindow = getCurrentWebviewWindow();

  // Platform styling is independent of extraction startup; do not put it on
  // the critical path between first paint and starting 7-Zip.
  void invoke<string>("get_platform_info")
    .then((platform) => {
      if (["windows", "macos", "linux"].includes(platform)) {
        document.body.classList.add(`platform-${platform}`);
      }
    })
    .catch(() => {});

  // Wire custom titlebar buttons
  const minBtn = document.getElementById("titlebar-min");
  const closeTitlebarBtn = document.getElementById("titlebar-close");

  if (minBtn) {
    minBtn.addEventListener("click", () => {
      void appWindow.minimize();
    });
  }
  if (closeTitlebarBtn) {
    closeTitlebarBtn.addEventListener("click", () => {
      void closeWindowSafely();
    });
  }

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
    } catch (err) {
      cancelRequested = false;
      cancelBtn.disabled = false;
      const detail = err instanceof Error ? err.message : String(err);
      $("extract-error").hidden = false;
      const title = $("extract-error").querySelector<HTMLElement>(
        ".extract-error-title",
      );
      if (title) title.textContent = "Could not cancel safely";
      $("error-detail").textContent = detail;
      $("extract-status").textContent = "Extraction still running";
    }
  });

  closeBtn.addEventListener("click", async () => {
    await closeWindowSafely();
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
  $("extract-status").textContent = "Starting extraction...";
  $("extract-error").hidden = true;

  let sawStructuredPercent = false;

  const startedAt = Date.now();
  let lastFile = "";

  const [unlistenStructured, unlistenRaw] = await Promise.all([
    listen<ProgressUpdate>("7z-progress-structured", (event) => {
      const update = event.payload;
      let eta = "";
      if (typeof update?.percent === "number") {
        sawStructuredPercent = true;
        setDeterminateProgress(Math.min(99, update.percent));
        eta = formatEta(Date.now() - startedAt, update.percent);
      }
      if (update?.currentFile) {
        lastFile = basename(update.currentFile);
      }
      const label = lastFile ? `Extracting ${lastFile}...` : "Extracting...";
      $("extract-status").textContent = eta ? `${label}  ${eta}` : label;
    }),
    listen<string>("7z-progress", (event) => {
      if (sawStructuredPercent) return;
      const chunk = typeof event.payload === "string" ? event.payload : "";
      for (const line of chunk.split(/[\r\n]+/)) {
        const match = line.trim().match(/^-\s+(.+)/);
        if (match?.[1]) {
          $("extract-status").textContent =
            `Extracting ${basename(match[1])}...`;
        }
      }
    }),
  ]);

  const unlistenProgress = () => {
    unlistenStructured();
    unlistenRaw();
  };

  $("extract-status").textContent = "Extracting...";

  const args = [
    "x",
    `-o${destination}`,
    SAFE_EXTRACT_OVERWRITE_MODE,
    "-bb1",
    "-bsp1",
    "--",
    archivePath,
  ];

  try {
    const result = await runWithPasswordRetry(args);
    unlistenProgress();

    if (cancelRequested) {
      finish("Cancelled", 100, false, false, true);
      return;
    }

    if (result.code !== 0) {
      const hint = describe7zError(result.stdout ?? "", result.stderr ?? "");
      const base = result.stderr?.trim() || `Exit code ${result.code}`;
      showError(hint ? `${hint}\n\n${base}` : base);
      return;
    }

    finish("Done", 100);
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
