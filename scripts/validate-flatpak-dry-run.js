#!/usr/bin/env node
/**
 * Flatpak packaging dry-run: verify required metadata/templates exist so CI
 * can catch drift without needing a full flatpak-builder install.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { hasExactReleaseVersion } from "./update-metainfo.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "run.rosie.zinnia.metainfo.xml",
  "run.rosie.zinnia.yml",
  "run.rosie.zinnia.desktop",
  "src-tauri/linux/desktop-template.hbs",
  "scripts/prepare-flatpak-source.js",
];
const expectedRuntime = 'runtime-version: "50"';

let failed = false;
for (const rel of required) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    console.error(`flatpak-dry-run: missing ${rel}`);
    failed = true;
  }
}

const sourceExporter = path.join(root, "scripts", "prepare-flatpak-source.js");
if (fs.existsSync(sourceExporter)) {
  const source = fs.readFileSync(sourceExporter, "utf8");
  for (const marker of [
    "git",
    "archive",
    "--porcelain=v1",
    ".zinnia-source-commit",
    "src-tauri/gen/schemas/",
  ]) {
    if (!source.includes(marker)) {
      console.error(`flatpak-dry-run: source exporter missing ${marker}`);
      failed = true;
    }
  }
}

const manifest = path.join(root, "run.rosie.zinnia.yml");
if (fs.existsSync(manifest)) {
  const yaml = fs.readFileSync(manifest, "utf8");
  if (!yaml.includes(expectedRuntime)) {
    console.error(`flatpak-dry-run: expected ${expectedRuntime}`);
    failed = true;
  }
  if (!yaml.includes("path: .flatpak-source")) {
    console.error(
      "flatpak-dry-run: build source must be a clean commit export",
    );
    failed = true;
  }
  if (!yaml.includes("npm ci") || !yaml.includes("--share=network")) {
    console.error(
      "flatpak-dry-run: sideload build must fetch integrity-locked dependencies explicitly",
    );
    failed = true;
  }
  if (
    !yaml.includes("npm@12 --") ||
    !yaml.includes("--before=") ||
    !yaml.includes("3 days ago")
  ) {
    console.error(
      "flatpak-dry-run: node22 SDK npm 10.x must be upgraded to newest npm 12 with a 3-day --before age gate before npm ci",
    );
    failed = true;
  }
  if (!yaml.includes("tauri build --no-bundle -- --locked")) {
    console.error("flatpak-dry-run: Cargo build must enforce Cargo.lock");
    failed = true;
  }
}

const metainfo = path.join(root, "run.rosie.zinnia.metainfo.xml");
if (fs.existsSync(metainfo)) {
  const xml = fs.readFileSync(metainfo, "utf8");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  if (!hasExactReleaseVersion(xml, pkg.version)) {
    console.error(
      `flatpak-dry-run: metainfo needs an exact release version="${pkg.version}" attribute`,
    );
    failed = true;
  }
  for (const requiredMarkup of [
    '<component type="desktop-application">',
    '<developer id="run.rosie">',
    '<launchable type="desktop-id">run.rosie.zinnia.desktop</launchable>',
  ]) {
    if (!xml.includes(requiredMarkup)) {
      console.error(`flatpak-dry-run: metainfo missing ${requiredMarkup}`);
      failed = true;
    }
  }
}

function runValidator(command, args) {
  const probe = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    console.log(`flatpak-dry-run: ${command} unavailable; static checks only`);
    return;
  }
  if (probe.error || probe.status !== 0) {
    console.error(
      `flatpak-dry-run: ${command} validation failed:\n${probe.stderr || probe.stdout || probe.error?.message}`,
    );
    failed = true;
  }
}

runValidator("appstreamcli", [
  "validate",
  "--no-net",
  "run.rosie.zinnia.metainfo.xml",
]);
runValidator("desktop-file-validate", ["run.rosie.zinnia.desktop"]);

// Keep compound TAR MIME types distinct from plain compressions across packaging
// surfaces. AppImage reuses debian::generate_data, so deb.desktopTemplate also
// covers AppImage desktop entries (Open/Extract/Compress + MimeType list).
const compoundMimeByExt = {
  tgz: "application/x-compressed-tar",
  tbz2: "application/x-bzip2-compressed-tar",
  txz: "application/x-xz-compressed-tar",
};
const associationConfigs = [
  "src-tauri/tauri.conf.json",
  "src-tauri/tauri.linux.conf.json",
  "src-tauri/tauri.macos.conf.json",
  "src-tauri/tauri.windows.conf.json",
];
for (const rel of associationConfigs) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    console.error(`flatpak-dry-run: missing ${rel}`);
    failed = true;
    continue;
  }
  const conf = JSON.parse(fs.readFileSync(full, "utf8"));
  const associations = conf.bundle?.fileAssociations ?? [];
  const byExt = new Map();
  for (const association of associations) {
    const mime = association.mimeType;
    for (const ext of association.ext ?? []) {
      byExt.set(String(ext).toLowerCase(), mime);
    }
  }
  for (const [ext, expectedMime] of Object.entries(compoundMimeByExt)) {
    const actual = byExt.get(ext);
    if (actual !== expectedMime) {
      console.error(
        `flatpak-dry-run: ${rel} maps .${ext} to ${actual ?? "(missing)"}; expected ${expectedMime}`,
      );
      failed = true;
    }
  }
}

const tauriConfPath = path.join(root, "src-tauri/tauri.conf.json");
if (fs.existsSync(tauriConfPath)) {
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
  const linux = tauriConf.bundle?.linux ?? {};
  for (const kind of ["deb", "rpm"]) {
    const template = linux[kind]?.desktopTemplate;
    if (template !== "linux/desktop-template.hbs") {
      console.error(
        `flatpak-dry-run: bundle.linux.${kind}.desktopTemplate must be linux/desktop-template.hbs`,
      );
      failed = true;
    }
  }
}

const desktopTemplate = path.join(root, "src-tauri/linux/desktop-template.hbs");
if (fs.existsSync(desktopTemplate)) {
  const hbs = fs.readFileSync(desktopTemplate, "utf8");
  for (const marker of [
    "application/x-compressed-tar",
    "application/x-bzip2-compressed-tar",
    "application/x-xz-compressed-tar",
    "Actions=Open;Extract;Compress;",
    "Exec={{exec}} --extract %F",
    "Exec={{exec}} --compress %F",
  ]) {
    if (!hbs.includes(marker)) {
      console.error(`flatpak-dry-run: desktop template missing ${marker}`);
      failed = true;
    }
  }
}

const cargoToml = path.join(root, "src-tauri/Cargo.toml");
const vendorUpdater = path.join(
  root,
  "src-tauri/vendor/tauri-plugin-updater/src/updater.rs",
);
if (fs.existsSync(cargoToml)) {
  const cargo = fs.readFileSync(cargoToml, "utf8");
  if (
    !cargo.includes(
      'tauri-plugin-updater = { path = "vendor/tauri-plugin-updater" }',
    )
  ) {
    console.error(
      "flatpak-dry-run: Cargo.toml must path-patch tauri-plugin-updater for macOS install quoting",
    );
    failed = true;
  }
}
if (!fs.existsSync(vendorUpdater)) {
  console.error(
    "flatpak-dry-run: missing vendored tauri-plugin-updater sources",
  );
  failed = true;
} else {
  const updaterSrc = fs.readFileSync(vendorUpdater, "utf8");
  for (const marker of ["quoted form of", "execute_function"]) {
    if (!updaterSrc.includes(marker)) {
      console.error(
        `flatpak-dry-run: vendored updater missing privileged-install marker ${marker}`,
      );
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("flatpak-dry-run: ok");
