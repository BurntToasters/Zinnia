const RECENT_ARCHIVES_KEY = "zinnia.basic.recentArchives";
const MAX_RECENT_ARCHIVES = 5;

function basename(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0 ? path.slice(sep + 1) : path;
}

let recentArchiveHandler: ((path: string) => void) | null = null;

/** Wire the click handler from init to avoid a recent ↔ actions cycle. */
export function setRecentArchiveHandler(handler: (path: string) => void): void {
  recentArchiveHandler = handler;
}

export function loadRecentArchives(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_ARCHIVES_KEY);
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
    localStorage.setItem(
      RECENT_ARCHIVES_KEY,
      JSON.stringify(paths.slice(0, MAX_RECENT_ARCHIVES)),
    );
  } catch {
    // ignore quota / private mode
  }
}

export function rememberRecentArchive(path: string): void {
  if (!path) return;
  const next = [path, ...loadRecentArchives().filter((p) => p !== path)].slice(
    0,
    MAX_RECENT_ARCHIVES,
  );
  saveRecentArchives(next);
  renderRecentArchives();
}

export function renderRecentArchives(): void {
  const wrap = document.getElementById("basic-recent");
  const list = document.getElementById("basic-recent-list");
  if (!wrap || !list) return;
  const recent = loadRecentArchives();
  list.replaceChildren();
  if (recent.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  for (const path of recent) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "basic-recent__item";
    btn.textContent = basename(path);
    btn.title = path;
    btn.addEventListener("click", () => {
      recentArchiveHandler?.(path);
    });
    list.appendChild(btn);
  }
}
