import type { ArchiveInfo, BrowseEntry } from "../browse-model";
import { isEncryptedFlag, methodLooksEncrypted } from "./args";

export function parseArchiveListing(stdout: string): ArchiveInfo {
  const lines = stdout.split(/\r?\n/);
  const info: ArchiveInfo = {
    type: "",
    physicalSize: 0,
    method: "",
    solid: false,
    encrypted: false,
    entries: [],
  };
  let inArchiveInfo = false;
  let inFiles = false;
  let current: Partial<BrowseEntry> = {};

  const commitCurrent = (): void => {
    if (current.path === undefined) return;
    info.entries.push({
      path: current.path,
      size: current.size ?? 0,
      packedSize: current.packedSize ?? 0,
      modified: current.modified ?? "",
      isFolder: current.isFolder ?? false,
    });
    current = {};
  };

  for (const raw of lines) {
    const trimmed = raw.trim();

    // Real 7-Zip `l -slt` output separates file records with a blank line.
    // Keep support for repeated dashed separators because older/p7zip variants
    // and existing captured fixtures can emit those instead.
    if (inFiles && trimmed === "") {
      commitCurrent();
      continue;
    }

    if (trimmed === "--") {
      inArchiveInfo = true;
      continue;
    }

    if (trimmed.startsWith("----------")) {
      if (!inFiles) {
        inArchiveInfo = false;
        inFiles = true;
      } else commitCurrent();
      continue;
    }

    // Parse the key structurally, but preserve the value byte-for-byte. Leading
    // and trailing spaces and literal backslashes are valid POSIX member names.
    const eqIdx = raw.indexOf(" = ");
    if (eqIdx === -1) continue;
    const key = raw.substring(0, eqIdx).trim();
    const value = raw.substring(eqIdx + 3);

    if (inArchiveInfo) {
      if (key === "Type") info.type = value;
      else if (key === "Physical Size")
        info.physicalSize = parseInt(value) || 0;
      else if (key === "Method") {
        info.method = value;
        if (methodLooksEncrypted(value)) info.encrypted = true;
      } else if (key === "Solid") info.solid = value === "+";
      else if (key === "Encrypted" && isEncryptedFlag(value))
        info.encrypted = true;
    } else if (inFiles) {
      if (key === "Path") current.path = value;
      else if (key === "Size") current.size = parseInt(value) || 0;
      else if (key === "Packed Size") current.packedSize = parseInt(value) || 0;
      else if (key === "Modified") current.modified = value;
      else if (key === "Folder") current.isFolder = value === "+";
      else if (key === "Attributes")
        current.isFolder = value.trimStart().startsWith("D");
      else if (key === "Encrypted" && isEncryptedFlag(value))
        info.encrypted = true;
      else if (key === "Method" && methodLooksEncrypted(value))
        info.encrypted = true;
    }
  }

  commitCurrent();

  return info;
}
