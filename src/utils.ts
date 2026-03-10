export const MAX_LOG_LINES = 1000;
export const SAFE_URL_PATTERN = /^https?:\/\//i;

export const ARCHIVE_EXTENSIONS = new Set([
  ".7z", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".tbz2",
  ".xz", ".txz", ".rar",
]);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el as T;
}

export function parseThreads(raw: string, fallback: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(1, Math.min(128, n));
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return "\u2014";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
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

const TOKEN_LIKE_PATTERN = /\b(?:ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b/g;
const KEY_VALUE_SECRET_PATTERN = /\b(password|passphrase|token|private[_-]?key)\s*[:=]\s*\S+/gi;
const ARG_PASSWORD_PATTERN = /-p\S*/gi;

export function redactSensitiveText(input: string): string {
  return input
    .replace(ARG_PASSWORD_PATTERN, "-p***")
    .replace(KEY_VALUE_SECRET_PATTERN, (_match, key: string) => `${key}=***`)
    .replace(TOKEN_LIKE_PATTERN, "***");
}

export function safeHref(url: string): string {
  return SAFE_URL_PATTERN.test(url) ? escapeHtml(url) : "#";
}

export function isArchiveFile(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of ARCHIVE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}
