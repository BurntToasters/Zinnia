import { looksLikeWindowsPath } from "./extract-path";

/** Return the final component of either a POSIX or Windows path. */
export function basename(filePath: string): string {
  // `\` only separates Windows-shaped paths; on POSIX it is a file name character.
  const separator = Math.max(
    filePath.lastIndexOf("/"),
    looksLikeWindowsPath(filePath) ? filePath.lastIndexOf("\\") : -1,
  );
  return separator >= 0 ? filePath.slice(separator + 1) : filePath;
}
