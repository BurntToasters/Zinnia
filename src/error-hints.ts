export function looksLikePasswordRequiredError(
  stdout: string,
  stderr: string,
): boolean {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return (
    combined.includes("wrong password") ||
    combined.includes("can not open encrypted archive") ||
    combined.includes("can't open encrypted archive") ||
    combined.includes("encrypted headers") ||
    combined.includes("enter password") ||
    combined.includes("password is required")
  );
}

// Map common 7z failure output to a short, actionable hint. "" when unrecognized.
export function describe7zError(stdout: string, stderr: string): string {
  const text = `${stdout}\n${stderr}`.toLowerCase();

  if (looksLikePasswordRequiredError(stdout, stderr)) {
    return "Wrong or missing password. Enter the archive password and try again.";
  }
  if (
    text.includes("no space left") ||
    text.includes("disk full") ||
    text.includes("not enough space")
  ) {
    return "Not enough disk space at the destination. Free up space or choose another location.";
  }
  if (
    text.includes("can not open") &&
    (text.includes("as archive") || text.includes("not supported"))
  ) {
    return "The file is not a supported archive or is corrupted. Try testing the archive first.";
  }
  if (
    text.includes("unsupported method") ||
    text.includes("unsupported compression") ||
    text.includes("method is not supported")
  ) {
    return "This archive uses a compression method 7-Zip can't decode here.";
  }
  if (
    text.includes("crc failed") ||
    text.includes("data error") ||
    text.includes("headers error") ||
    text.includes("unexpected end of")
  ) {
    return "The archive appears damaged (CRC/data error). Re-download or repair it.";
  }
  if (
    text.includes("access is denied") ||
    text.includes("permission denied") ||
    text.includes("cannot create") ||
    text.includes("can not create")
  ) {
    return "Permission denied writing to the destination. Pick a folder you can write to.";
  }
  if (text.includes("the system cannot find") || text.includes("not found")) {
    return "A file or folder in the operation no longer exists. Refresh your selection.";
  }
  return "";
}

/** User-visible failure text for Basic and toasts; never raw 7-Zip stderr. */
export function userFacing7zErrorDetail(
  stdout: string,
  stderr: string,
  fallback = "Something went wrong. Check the activity log for details.",
): string {
  const hint = describe7zError(stdout, stderr);
  return hint || fallback;
}

function looksLikeRaw7zOutput(detail: string): boolean {
  if (detail.includes("7-Zip (")) return true;
  for (const line of detail.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith("ERROR:") ||
      trimmed.startsWith("WARNING:") ||
      trimmed.startsWith("Open ERROR") ||
      trimmed.startsWith("Can not open") ||
      trimmed.startsWith("Cannot open")
    ) {
      return true;
    }
  }
  return false;
}

/** User-visible text for a rejected backend `invoke`; never raw 7-Zip output. */
export function userFacingBackendError(detail: string): string {
  const hint = describe7zError("", detail);
  if (hint) return hint;
  if (looksLikeRaw7zOutput(detail)) {
    return "Something went wrong. Check the activity log for details.";
  }
  return detail;
}
