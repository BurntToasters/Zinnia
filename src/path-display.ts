/** Return the final component of either a POSIX or Windows path. */
export function basename(filePath: string): string {
  const separator = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  return separator >= 0 ? filePath.slice(separator + 1) : filePath;
}
