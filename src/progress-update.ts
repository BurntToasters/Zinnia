export interface ProgressUpdate {
  percent?: number;
  filesDone?: number;
  currentFile?: string;
}

export function formatEta(elapsedMs: number, percent: number): string {
  if (percent <= 0 || percent >= 100 || elapsedMs <= 0) return "";
  const totalMs = elapsedMs / (percent / 100);
  const remainingSec = Math.max(0, Math.round((totalMs - elapsedMs) / 1000));
  if (remainingSec < 1) return "";
  if (remainingSec < 60) return `~${remainingSec}s left`;
  const minutes = Math.floor(remainingSec / 60);
  const seconds = remainingSec % 60;
  return `~${minutes}m ${seconds.toString().padStart(2, "0")}s left`;
}
