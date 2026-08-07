export const MAX_LOG_LINES = 1000;
export const SAFE_URL_PATTERN = /^https?:\/\//i;

export const ARCHIVE_EXTENSIONS = new Set([
  ".7z",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".tbz2",
  ".xz",
  ".txz",
  ".rar",
]);

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el as T;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

const activeFocusTraps = new Map<HTMLElement, (e: KeyboardEvent) => void>();
const focusTrapStack: HTMLElement[] = [];
const isolatedForModal = new Map<HTMLElement, HTMLElement[]>();
const activatedAncestorsForModal = new Map<HTMLElement, HTMLElement[]>();
const isolationState = new Map<
  HTMLElement,
  { count: number; wasInert: boolean }
>();

/** Window chrome that stays clickable above modal sheets (gear, Support, close). */
function keepInteractiveDuringModal(element: HTMLElement): boolean {
  return element.id === "titlebar" || element.classList.contains("header");
}

function isolateModalBackground(container: HTMLElement): void {
  const isolated: HTMLElement[] = [];
  const activatedAncestors: HTMLElement[] = [];
  let branch: HTMLElement = container;
  while (branch.parentElement && branch !== document.body) {
    if (branch.inert && isolationState.has(branch)) {
      branch.inert = false;
      activatedAncestors.push(branch);
    }
    for (const sibling of branch.parentElement.children) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      if (keepInteractiveDuringModal(sibling)) continue;
      const existing = isolationState.get(sibling);
      if (existing) {
        existing.count += 1;
      } else {
        isolationState.set(sibling, {
          count: 1,
          wasInert: sibling.inert === true,
        });
        sibling.inert = true;
      }
      isolated.push(sibling);
    }
    branch = branch.parentElement;
  }
  isolatedForModal.set(container, isolated);
  activatedAncestorsForModal.set(container, activatedAncestors);
}

function restoreModalBackground(container: HTMLElement): void {
  for (const element of isolatedForModal.get(container) ?? []) {
    const state = isolationState.get(element);
    if (!state) continue;
    state.count -= 1;
    if (state.count === 0) {
      element.inert = state.wasInert;
      isolationState.delete(element);
    }
  }
  for (const element of activatedAncestorsForModal.get(container) ?? []) {
    if (isolationState.has(element)) element.inert = true;
  }
  isolatedForModal.delete(container);
  activatedAncestorsForModal.delete(container);
}

export function trapFocus(container: HTMLElement): void {
  if (activeFocusTraps.has(container)) {
    releaseFocusTrap(container);
  }
  const handler = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    // Only the topmost trapped sheet owns Tab (settings can open over selective).
    if (focusTrapStack[focusTrapStack.length - 1] !== container) return;
    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!container.contains(document.activeElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    const activeElement = document.activeElement;
    // A dialog can intentionally focus a programmatic-only element such as a
    // heading. It is inside the modal but absent from the sequential focus
    // list, so it must enter the same wrap path as focus outside the modal.
    if (!focusable.includes(activeElement as HTMLElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey) {
      if (activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  activeFocusTraps.set(container, handler);
  focusTrapStack.push(container);
  document.addEventListener("keydown", handler);
  isolateModalBackground(container);
  const first = container.querySelector<HTMLElement>(FOCUSABLE);
  if (first) first.focus();
}

export function releaseFocusTrap(container: HTMLElement): void {
  const handler = activeFocusTraps.get(container);
  if (handler) {
    document.removeEventListener("keydown", handler);
    activeFocusTraps.delete(container);
  }
  const stackIndex = focusTrapStack.lastIndexOf(container);
  if (stackIndex >= 0) focusTrapStack.splice(stackIndex, 1);
  restoreModalBackground(container);
}

export function parseThreads(raw: string, fallback: number): number {
  const clampedFallback = Math.max(1, Math.min(128, fallback));
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return clampedFallback;
  return Math.max(1, Math.min(128, n));
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function splitArgs(raw: string) {
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const out: string[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(raw)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

const TOKEN_LIKE_PATTERN =
  /\b(?:ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const JWT_LIKE_PATTERN =
  /\beyJ[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{6,}\b/g;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9]{20,}\b/g;
const KEY_VALUE_SECRET_PATTERN =
  /\b(password|passphrase|token|private[_-]?key)\s*([:=])\s*\S+/gi;
// 7-Zip accepts the password directly after `-p` / `-P`. A rendered command
// cannot distinguish a password containing spaces from following arguments,
// so fail closed and redact the rest of that log line. Already-sanitized
// `-p***` tokens are left intact so later args remain visible. `-spd` is
// preserved because the password switch must start at a token boundary.
const ARG_PASSWORD_PATTERN = /(^|[^\S\r\n])-p(?!\*\*\*(?:\s|$))[^\r\n]*/gim;

export function redactSensitiveText(input: string): string {
  return input
    .replace(BEARER_TOKEN_PATTERN, "Bearer ***")
    .replace(JWT_LIKE_PATTERN, "***")
    .replace(OPENAI_KEY_PATTERN, "***")
    .replace(ARG_PASSWORD_PATTERN, "$1-p***")
    .replace(
      KEY_VALUE_SECRET_PATTERN,
      (_match, key: string, sep: string) => `${key}${sep}***`,
    )
    .replace(TOKEN_LIKE_PATTERN, "***");
}

export function safeHref(url: string): string {
  if (
    !SAFE_URL_PATTERN.test(url) ||
    url.trim() !== url ||
    /[\u0000-\u001F]/.test(url)
  ) {
    return "#";
  }
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password
      ? url
      : "#";
  } catch {
    return "#";
  }
}

export function isArchiveFile(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of ARCHIVE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Validate that a value from invoke() has the expected shape at runtime.
 * Throws with a clear message if the backend returned an unexpected payload.
 */
export function assertRunResult(value: unknown): asserts value is {
  stdout: string;
  stderr: string;
  code: number;
  warning_code?: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
} {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as Record<string, unknown>).stdout !== "string" ||
    typeof (value as Record<string, unknown>).stderr !== "string" ||
    typeof (value as Record<string, unknown>).code !== "number"
  ) {
    throw new Error(
      `Unexpected run_7z response shape: ${JSON.stringify(value)?.slice(0, 200)}`,
    );
  }
}
