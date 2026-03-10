import { isArchiveFile } from "./utils.ts";

export const ALLOWED_EXTRA_PREFIXES = [
  "-m", "-x", "-i", "-ao", "-bb", "-bs", "-bt",
  "-scs", "-slt", "-sns", "-snl", "-sni", "-stl",
  "-slp", "-ssp", "-ssw", "-y", "-r", "-w",
];

export function validateExtraArgs(args: string[]): void {
  const blocked = ["-sdel", "-p", "-mhe", "-o", "-si", "-so", "-t"];

  for (const arg of args) {
    if (!arg.startsWith("-")) {
      throw new Error(`Extra arguments must start with '-'. Invalid: ${arg}`);
    }

    const lower = arg.toLowerCase();
    if (blocked.some(b => lower.startsWith(b))) {
      throw new Error(
        `"${arg}" is not allowed in extra args. Use the dedicated fields instead.`
      );
    }

    if (!ALLOWED_EXTRA_PREFIXES.some(p => lower.startsWith(p))) {
      throw new Error(
        `Unknown argument "${arg}". Only recognized 7z switches are allowed.`
      );
    }
  }
}

export function ensureArchivePaths(paths: string[], context: "browse" | "extract" | "test"): void {
  const invalid = paths.filter(path => !isArchiveFile(path));
  if (invalid.length === 0) return;

  const sample = invalid.slice(0, 3).join(", ");
  const more = invalid.length > 3 ? ` (+${invalid.length - 3} more)` : "";
  const noun = invalid.length === 1 ? "input is" : "inputs are";
  throw new Error(
    `Only supported archive files can be used for ${context}. ${invalid.length} ${noun} invalid: ${sample}${more}`
  );
}
