#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(root, "public", "7zip-license.txt");
const provenance = JSON.parse(
  readFileSync(join(root, "assets", "7z-provenance.json"), "utf8"),
);
const notices = [
  {
    label: `Official 7-Zip ${provenance.version} notice for Windows`,
    fileName: "7ZIP_LICENSE_WINDOWS.txt",
    source: join(root, "assets", "7ZIP_LICENSE_WINDOWS.txt"),
    destination: join(root, "public", "7zip-license-windows.txt"),
  },
  {
    label: `Official 7-Zip ${provenance.version} notice for Linux and macOS`,
    fileName: "7ZIP_LICENSE_LINUX_MACOS.txt",
    source: join(root, "assets", "7ZIP_LICENSE_LINUX_MACOS.txt"),
    destination: join(root, "public", "7zip-license-linux-macos.txt"),
  },
];
mkdirSync(dirname(destination), { recursive: true });
const obsoleteDestination = join(
  root,
  "public",
  "7zip-license-windows-extra.txt",
);
if (existsSync(obsoleteDestination)) {
  rmSync(obsoleteDestination, { force: true });
}
for (const notice of notices) {
  const expected = provenance.licenseNotices?.[notice.fileName]?.sha256;
  const bytes = readFileSync(notice.source);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!expected || actual !== expected) {
    throw new Error(
      `7-Zip notice provenance mismatch for ${notice.fileName}: expected ${expected || "a recorded hash"}, got ${actual}`,
    );
  }
  copyFileSync(notice.source, notice.destination);
}
const combined = notices
  .map(
    (notice) =>
      `${notice.label}\n${"=".repeat(notice.label.length)}\n\n${readFileSync(notice.source, "utf8").trimEnd()}`,
  )
  .join("\n\n\n");
writeFileSync(destination, `${combined}\n`, "utf8");
console.log(
  `[licenses:7zip] Wrote ${destination} and ${notices.length} exact platform notice files`,
);
