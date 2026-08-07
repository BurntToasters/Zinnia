import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const MAX_LOG_LINES = 1000;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

function trimLog(logEl: HTMLElement): void {
  const text = logEl.textContent || "";
  const lines = text.split("\n");
  if (lines.length > MAX_LOG_LINES) {
    logEl.textContent = lines.slice(lines.length - MAX_LOG_LINES).join("\n");
  }
}

function appendLine(line: string): void {
  const logEl = $("dbg-log");
  logEl.textContent += `${line}\n`;
  trimLog(logEl);
  logEl.scrollTop = logEl.scrollHeight;
}

async function syncThemeAndFx(): Promise<void> {
  let supports = false;
  try {
    supports = await invoke<boolean>("supports_workspace_window_fx");
  } catch {
    supports = false;
  }

  let effectsEnabled = true;
  let themePref = "system";
  try {
    const raw = await invoke<string>("load_settings");
    const parsed = JSON.parse(raw) as {
      basicWindowEffects?: unknown;
      theme?: unknown;
    };
    if (typeof parsed.basicWindowEffects === "boolean") {
      effectsEnabled = parsed.basicWindowEffects;
    }
    if (typeof parsed.theme === "string") {
      themePref = parsed.theme;
    }
  } catch {
    // Defaults match SETTING_DEFAULTS.
  }

  const dark =
    themePref === "dark" ||
    (themePref !== "light" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");

  const enabled = supports && effectsEnabled;
  document.documentElement.dataset.windowFx = enabled ? "basic" : "opaque";
  try {
    await invoke("set_workspace_window_fx", { enabled, dark });
  } catch {
    // CSS still paints correctly if native vibrancy is unavailable.
  }
}

async function closeWindow(
  options: { clearPreference?: boolean } = {},
): Promise<void> {
  // Explicit Dock / titlebar close should forget pop-out across launches.
  // Native Destroyed alone must not (app quit also destroys this window).
  if (options.clearPreference !== false) {
    try {
      await emit("zinnia-debug-console-dock-request");
    } catch {
      // Main may already be gone.
    }
  }
  try {
    await emit("zinnia-debug-console-closed");
  } catch {
    // Main may already be gone.
  }
  try {
    await invoke("close_debug_console_window");
  } catch {
    const appWindow = getCurrentWebviewWindow();
    await appWindow.destroy().catch(() => undefined);
  }
}

async function run(): Promise<void> {
  const appWindow = getCurrentWebviewWindow();

  void invoke<string>("get_platform_info")
    .then((platform) => {
      if (["windows", "macos", "linux"].includes(platform)) {
        document.body.classList.add(`platform-${platform}`);
      }
    })
    .catch(() => {});
  void syncThemeAndFx();

  $("titlebar-min").addEventListener("click", () => {
    void appWindow.minimize();
  });
  $("titlebar-max").addEventListener("click", async () => {
    if (await appWindow.isMaximized()) {
      await appWindow.unmaximize();
    } else {
      await appWindow.maximize();
    }
  });
  $("titlebar-close").addEventListener("click", () => {
    void closeWindow();
  });

  $("dbg-clear").addEventListener("click", () => {
    $("dbg-log").textContent = "";
    void emit("zinnia-debug-console-clear-request");
  });
  $("dbg-copy").addEventListener("click", async () => {
    const text = $("dbg-log").textContent ?? "";
    if (!text.trim()) return;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(text);
      const btn = $("dbg-copy");
      btn.textContent = "Copied";
      window.setTimeout(() => {
        btn.textContent = "Copy";
      }, 1300);
    } catch {
      const btn = $("dbg-copy");
      btn.textContent = "Copy failed";
      window.setTimeout(() => {
        btn.textContent = "Copy";
      }, 1300);
    }
  });
  $("dbg-dock").addEventListener("click", () => {
    void closeWindow();
  });

  await listen<string>("zinnia-debug-log", (event) => {
    if (typeof event.payload === "string") appendLine(event.payload);
  });
  await listen<string[]>("zinnia-debug-seed", (event) => {
    const lines = event.payload;
    if (!Array.isArray(lines)) return;
    const logEl = $("dbg-log");
    logEl.textContent = "";
    for (const line of lines) {
      if (typeof line === "string") appendLine(line);
    }
  });
  await listen("zinnia-debug-clear", () => {
    $("dbg-log").textContent = "";
  });

  // Ask main to seed buffered lines after listeners are attached.
  await emit("zinnia-debug-console-ready");
}

run().catch((err) => {
  document.body.textContent = `Fatal: ${err instanceof Error ? err.message : String(err)}`;
});
