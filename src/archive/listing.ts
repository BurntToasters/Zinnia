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

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (trimmed === "--") {
      inArchiveInfo = true;
      continue;
    }

    if (trimmed.startsWith("----------")) {
      if (!inFiles) {
        inArchiveInfo = false;
        inFiles = true;
      } else if (current.path !== undefined) {
        info.entries.push({
          path: current.path,
          size: current.size ?? 0,
          packedSize: current.packedSize ?? 0,
          modified: current.modified ?? "",
          isFolder: current.isFolder ?? false,
        });
        current = {};
      }
      continue;
    }

    const eqIdx = trimmed.indexOf(" = ");
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx);
    const value = trimmed.substring(eqIdx + 3);

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
      else if (key === "Encrypted" && isEncryptedFlag(value))
        info.encrypted = true;
      else if (key === "Method" && methodLooksEncrypted(value))
        info.encrypted = true;
    }
  }

  if (current.path !== undefined) {
    info.entries.push({
      path: current.path,
      size: current.size ?? 0,
      packedSize: current.packedSize ?? 0,
      modified: current.modified ?? "",
      isFolder: current.isFolder ?? false,
    });
  }

  return info;
}
