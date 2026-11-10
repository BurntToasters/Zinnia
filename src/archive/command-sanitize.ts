const PASSWORD_MASK = "-p***";

function isPasswordSwitchArg(arg: string): boolean {
  const lower = arg.toLowerCase();
  // `-spd` is DisableWildcardMatching, not a password switch.
  if (lower === "-spd" || lower.startsWith("-spd")) return false;
  return lower === "-p" || lower.startsWith("-p");
}

/** Redact 7-Zip password switches for previews and debug dumps. */
export function sanitizeCommandArgsForPreview(args: string[]): string[] {
  return args.map((arg) => {
    if (isPasswordSwitchArg(arg)) return PASSWORD_MASK;
    return arg;
  });
}

const PLAIN_ARG = /^[A-Za-z0-9_./:=+@%,-]+$/;

function quoteForPreview(arg: string): string {
  if (PLAIN_ARG.test(arg)) return arg;
  // app-init adds platform-windows to <body> once the platform is known.
  if (document.body.classList.contains("platform-windows")) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Preview text that can be pasted into a shell. Password switches are masked
 * before quoting, and the mask is printed as-is.
 */
export function buildCommandPreviewText(args: string[]): string {
  const parts = args.map((arg) =>
    isPasswordSwitchArg(arg) ? PASSWORD_MASK : quoteForPreview(arg),
  );
  return `7z ${parts.join(" ")}`;
}
