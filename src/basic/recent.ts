import { validateArchivePaths } from "../archive-rules";

const RECENT_ARCHIVES_KEY = "zinnia.basic.recentArchives";
const MAX_RECENT_ARCHIVES = 5;

function basename(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0 ? path.slice(sep + 1) : path;
}

let recentArchiveHandler: ((path: string) => void) | null = null;
let menuWired = false;
/** Bumps whenever the stored list changes so an in-flight prune cannot clobber it. */
let recentListEpoch = 0;
/** Bumps on close / superseded open so a late prune cannot reopen the menu. */
let menuOpenGeneration = 0;

/** Wire the click handler from init to avoid a recent ↔ actions cycle. */
export function setRecentArchiveHandler(handler: (path: string) => void): void {
  recentArchiveHandler = handler;
}

export function loadRecentArchives(): string[] {
  try {
    // Archive paths disclose user and project names. Keep recents only for the
    // current app session and erase the legacy persistent copy on upgrade.
    localStorage.removeItem(RECENT_ARCHIVES_KEY);
    const raw = sessionStorage.getItem(RECENT_ARCHIVES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
      .slice(0, MAX_RECENT_ARCHIVES);
  } catch {
    return [];
  }
}

export function saveRecentArchives(paths: string[]): void {
  try {
    localStorage.removeItem(RECENT_ARCHIVES_KEY);
    sessionStorage.setItem(
      RECENT_ARCHIVES_KEY,
      JSON.stringify(paths.slice(0, MAX_RECENT_ARCHIVES)),
    );
    recentListEpoch += 1;
  } catch {
    // ignore quota / private mode
  }
}

function isMissingPathReason(reason: string | undefined): boolean {
  return reason === "File does not exist.";
}

/** Drop recent entries whose paths are gone from disk; persist the pruned list. */
export async function pruneMissingRecentArchives(): Promise<string[]> {
  const recent = loadRecentArchives();
  if (recent.length === 0) return [];
  const epochAtStart = recentListEpoch;
  try {
    const results = await validateArchivePaths(recent);
    if (epochAtStart !== recentListEpoch) {
      return loadRecentArchives();
    }
    const byPath = new Map(results.map((result) => [result.path, result]));
    const kept = recent.filter((path) => {
      const result = byPath.get(path);
      if (!result) return true;
      return !isMissingPathReason(result.reason);
    });
    if (kept.length !== recent.length) {
      saveRecentArchives(kept);
    }
    return kept;
  } catch {
    // Keep the list if probing fails (e.g. invoke unavailable in tests).
    return loadRecentArchives();
  }
}

export function rememberRecentArchive(path: string): void {
  if (!path) return;
  const next = [path, ...loadRecentArchives().filter((p) => p !== path)].slice(
    0,
    MAX_RECENT_ARCHIVES,
  );
  saveRecentArchives(next);
  void refreshRecentArchives();
}

function setRecentMenuOpen(open: boolean): void {
  const wrap = document.getElementById("header-recent");
  const btn = document.getElementById(
    "header-recent-btn",
  ) as HTMLButtonElement | null;
  const menu = document.getElementById("header-recent-menu");
  if (!wrap || !btn || !menu) return;
  wrap.classList.toggle("is-open", open);
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  menu.hidden = !open;
}

function closeRecentMenu(): void {
  menuOpenGeneration += 1;
  setRecentMenuOpen(false);
}

function wireRecentMenuOnce(): void {
  if (menuWired) return;
  const wrap = document.getElementById("header-recent");
  const btn = document.getElementById("header-recent-btn");
  if (!wrap || !btn) return;
  menuWired = true;

  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = !wrap.classList.contains("is-open");
    if (open) {
      const openGeneration = ++menuOpenGeneration;
      void refreshRecentArchives().then(() => {
        if (openGeneration !== menuOpenGeneration) return;
        if (loadRecentArchives().length === 0) return;
        setRecentMenuOpen(true);
      });
    } else {
      closeRecentMenu();
    }
  });

  document.addEventListener("click", (event) => {
    if (event.target instanceof Node && wrap.contains(event.target)) return;
    // Invalidate a pending open as well as an already-visible menu.
    closeRecentMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeRecentMenu();
  });
}

function renderRecentList(recent: string[]): void {
  const wrap = document.getElementById("header-recent");
  const list = document.getElementById("header-recent-menu");
  if (!wrap || !list) return;

  list.replaceChildren();
  if (recent.length === 0) {
    wrap.hidden = true;
    closeRecentMenu();
    return;
  }

  wrap.hidden = false;
  for (const path of recent) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "header-recent__item";
    btn.setAttribute("role", "menuitem");
    btn.textContent = basename(path);
    btn.title = path;
    btn.addEventListener("click", () => {
      closeRecentMenu();
      void (async () => {
        const kept = await pruneMissingRecentArchives();
        renderRecentList(kept);
        if (!kept.includes(path)) return;
        recentArchiveHandler?.(path);
      })();
    });
    list.appendChild(btn);
  }
}

/** Sync paint from session storage (no FS probe). Prefer `refreshRecentArchives`. */
export function renderRecentArchives(): void {
  wireRecentMenuOnce();
  renderRecentList(loadRecentArchives());
}

/** Prune missing paths, then paint the titlebar Recent control. */
export async function refreshRecentArchives(): Promise<void> {
  wireRecentMenuOnce();
  const recent = await pruneMissingRecentArchives();
  renderRecentList(recent);
}
