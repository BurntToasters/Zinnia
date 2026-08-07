function isPasswordSwitchArg(arg: string): boolean {
  const lower = arg.toLowerCase();
  // `-spd` is DisableWildcardMatching, not a password switch.
  if (lower === "-spd" || lower.startsWith("-spd")) return false;
  return lower === "-p" || lower.startsWith("-p");
}

/** Redact 7-Zip password switches for previews and debug dumps. */
export function sanitizeCommandArgsForPreview(args: string[]): string[] {
  return args.map((arg) => {
    if (isPasswordSwitchArg(arg)) return "-p***";
    return arg;
  });
}

export function buildCommandPreviewText(args: string[]): string {
  return `7z ${sanitizeCommandArgsForPreview(args).join(" ")}`;
}
