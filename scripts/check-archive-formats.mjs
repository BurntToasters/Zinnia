#!/usr/bin/env node
// Checks archive-formats.json against every hand-maintained archive extension and MIME list.
// Usage: node scripts/check-archive-formats.mjs [--root <dir>] [--json]
// Exit 0 when every list matches, 1 on any mismatch or parse failure, 2 on bad usage.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const MANIFEST = "archive-formats.json";
const PLATFORMS = ["windows", "macos", "linux"];
const ALL = PLATFORMS;
const WIN = ["windows"];
const MAC = ["macos"];
const LIN = ["linux"];
const C_STRING = /"([^"\n]*)"/g;
const WIDE_STRING = /L"([^"\n]*)"/g;
const CHAR_LITERAL = /'(?:\\.|[^\\'\n])'/y;
const CLOSERS = { "[": "]", "{": "}", "(": ")" };
const PLATFORM_KEYS = new Set(PLATFORMS);

class ParseError extends Error {}
class UsageError extends Error {}

// ---------- source scanning helpers ----------

function skipString(text, start) {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') {
    if (text[i] === "\\") i++;
    i++;
  }
  return i;
}

// Index just past a char literal starting at i, or -1. Rust lifetimes do not match.
function charLiteralEnd(text, i) {
  CHAR_LITERAL.lastIndex = i;
  const m = CHAR_LITERAL.exec(text);
  return m ? i + m[0].length : -1;
}

function findClosing(text, openIndex) {
  const open = text[openIndex];
  const close = CLOSERS[open];
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i = skipString(text, i);
      continue;
    }
    if (c === "'") {
      const end = charLiteralEnd(text, i);
      if (end !== -1) {
        i = end - 1;
        continue;
      }
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

// Strips // and /* */ comments while leaving string and char literals intact.
function stripCComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      const end = skipString(src, i);
      out += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === "'") {
      const end = charLiteralEnd(src, i);
      if (end !== -1) {
        out += src.slice(i, end);
        i = end;
        continue;
      }
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripXmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, "");
}

function stripComments(src, style) {
  if (style === "c") return stripCComments(src);
  if (style === "xml") return stripXmlComments(src);
  return src;
}

// Finds the single anchor match, then returns the bracketed block that follows it.
function findBlock(text, anchor, open, label, rel) {
  const found = [...text.matchAll(new RegExp(anchor.source, "g"))];
  if (found.length === 0)
    throw new ParseError(`could not find ${label} in ${rel}`);
  if (found.length > 1) {
    throw new ParseError(
      `found ${found.length} matches for ${label} in ${rel}; expected exactly 1`,
    );
  }
  const match = found[0];
  const openIndex = text.indexOf(open, match.index + match[0].length);
  if (openIndex === -1)
    throw new ParseError(`could not find '${open}' after ${label} in ${rel}`);
  const closeIndex = findClosing(text, openIndex);
  if (closeIndex === -1)
    throw new ParseError(`unbalanced '${open}' after ${label} in ${rel}`);
  return { inner: text.slice(openIndex + 1, closeIndex), match };
}

function literals(inner, re) {
  return [...inner.matchAll(re)].map((m) => m[1]);
}

function requireItems(items, label, rel) {
  if (items.length === 0)
    throw new ParseError(`found 0 entries for ${label} in ${rel}`);
  return items;
}

// ---------- per-location extractors ----------

// `within` scopes the search to one function body, so renaming that function also fails.
function scopedText(text, within, rel) {
  if (!within) return text;
  return findBlock(text, within.anchor, "{", within.label, rel).inner;
}

function listExtract({
  within,
  anchor,
  open = "[",
  label,
  literal = C_STRING,
}) {
  return (text, rel) => {
    const scope = scopedText(text, within, rel);
    const { inner } = findBlock(scope, anchor, open, label, rel);
    return { items: requireItems(literals(inner, literal), label, rel) };
  };
}

// Finds the one array inside a function body whose literals include `marker`.
function arrayContainingExtract({ anchor, label, marker }) {
  return (text, rel) => {
    const { inner } = findBlock(text, anchor, "{", label, rel);
    const arrays = [...inner.matchAll(/\[([^[\]]*)\]/g)]
      .map((m) => m[1])
      .filter((body) => body.includes(marker));
    if (arrays.length !== 1) {
      throw new ParseError(
        `could not find ${label} in ${rel} (${arrays.length} arrays contain ${marker})`,
      );
    }
    return { items: requireItems(literals(arrays[0], C_STRING), label, rel) };
  };
}

function hasSuffixExtract({ anchor, label }) {
  return (text, rel) => {
    const { inner } = findBlock(text, anchor, "{", label, rel);
    const items = literals(inner, /hasSuffix\("([^"\n]*)"\)/g);
    return { items: requireItems(items, label, rel) };
  };
}

function markerExtract({ anchor, label, pattern }) {
  return (text, rel) => {
    const { inner } = findBlock(text, anchor, "{", label, rel);
    return { present: pattern.test(inner) };
  };
}

function nsisCallsExtract(macro) {
  return (text, rel) => {
    if (!new RegExp(`^!macro ${macro}\\b`, "m").test(text)) {
      throw new ParseError(`could not find macro ${macro} in ${rel}`);
    }
    const re = new RegExp(
      `^[ \\t]*!insertmacro[ \\t]+${macro}[ \\t]+"(\\.[^"\\n]*)"[ \\t]*(?:;.*)?\\r?$`,
      "gm",
    );
    const items = [...text.matchAll(re)].map((m) => m[1]);
    return { items: requireItems(items, `!insertmacro ${macro} calls`, rel) };
  };
}

function tauriAssociationsExtract(label) {
  return (text, rel) => {
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new ParseError(`could not parse ${rel} as JSON: ${err.message}`);
    }
    const list = json?.bundle?.fileAssociations;
    if (!Array.isArray(list))
      throw new ParseError(`could not find bundle.fileAssociations in ${rel}`);
    const items = [];
    for (const entry of list) {
      if (!Array.isArray(entry?.ext)) {
        throw new ParseError(
          `bundle.fileAssociations entry without an ext array in ${rel}`,
        );
      }
      for (const ext of entry.ext) items.push({ ext, mime: entry.mimeType });
    }
    return { items: requireItems(items, label, rel) };
  };
}

function desktopMimeExtract(text, rel) {
  const lines = [...text.matchAll(/^MimeType=(.*?)\r?$/gm)];
  if (lines.length !== 1) {
    throw new ParseError(
      `expected exactly one MimeType= line in ${rel}, found ${lines.length}`,
    );
  }
  const items = lines[0][1].split(";").filter((s) => s.length > 0);
  return { items: requireItems(items, "MimeType=", rel) };
}

function metainfoMimeExtract(text, rel) {
  const items = literals(
    stripXmlComments(text),
    /<mediatype>([^<\n]*)<\/mediatype>/g,
  );
  return { items: requireItems(items, "<mediatype> entries", rel) };
}

function appxItemTypesExtract(text, rel) {
  const items = literals(
    stripXmlComments(text),
    /<desktop5:ItemType\s+Type="(\.[^"\n]*)"/g,
  );
  return {
    items: requireItems(items, "desktop5:ItemType extension entries", rel),
  };
}

function defaultTargetsExtract(text, rel) {
  const label = "ARCHIVE_DEFAULT_TARGETS";
  const { inner, match } = findBlock(
    text,
    /pub\(crate\) const ARCHIVE_DEFAULT_TARGETS: \[ArchiveDefaultTarget; (\d+)\] = /,
    "[",
    label,
    rel,
  );
  const declared = Number(match[1]);
  const re =
    /key:\s*"([^"\n]*)",\s*label:\s*"[^"\n]*",\s*extension:\s*"([^"\n]*)",\s*mime_type:\s*"([^"\n]*)"/g;
  const items = [...inner.matchAll(re)].map((m) => ({
    key: m[1],
    ext: m[2],
    mime: m[3],
  }));
  if (items.length !== declared) {
    throw new ParseError(
      `found ${items.length} ArchiveDefaultTarget entries in ${rel}; the array declares ${declared}`,
    );
  }
  return { items: requireItems(items, label, rel) };
}

function familyPairsExtract(text, rel) {
  const { inner } = findBlock(
    text,
    /fn expected_archive_family\(/,
    "{",
    "expected_archive_family",
    rel,
  );
  const re = /ends_with\("(\.[^"\n]*)"\)\s*\{\s*Some\("([^"\n]*)"\)\s*\}/g;
  const items = [...inner.matchAll(re)].map((m) => ({
    ext: m[1],
    family: m[2],
  }));
  return { items: requireItems(items, "expected_archive_family arms", rel) };
}

function keyedExtract(text, rel) {
  const label = "OUTPUT_SUFFIXES";
  const { inner } = findBlock(
    text,
    /const OUTPUT_SUFFIXES: Record<string, string\[\]> = /,
    "{",
    label,
    rel,
  );
  const re = /^\s*"?([A-Za-z0-9]+)"?\s*:\s*\[([^\]\n]*)\]/gm;
  const items = [...inner.matchAll(re)].map((m) => ({
    key: m[1],
    values: literals(m[2], C_STRING),
  }));
  return { items: requireItems(items, label, rel) };
}

function flatpakMimeExtract(text, rel) {
  const label = "compoundMimeByExt";
  const { inner } = findBlock(
    text,
    /const compoundMimeByExt = /,
    "{",
    label,
    rel,
  );
  const items = [...inner.matchAll(/(\w+):\s*"([^"\n]*)"/g)].map((m) => ({
    ext: m[1],
    mime: m[2],
  }));
  return { items: requireItems(items, label, rel) };
}

// ---------- location table ----------
// Each entry names one source list. `layer` ties it to a manifest layer (null = field-level check).
// `platforms` is where the list applies; a per-platform file lists only its own platform.

const LOCATIONS = [
  {
    id: "utils-ts",
    file: "src/utils.ts",
    layer: "frontendArchiveExtensions",
    platforms: ALL,
    comments: "c",
    kind: "ext",
    extract: listExtract({
      anchor: /export const ARCHIVE_EXTENSIONS = new Set\(/,
      label: "ARCHIVE_EXTENSIONS",
    }),
  },
  {
    id: "basic-wire-ts",
    file: "src/basic/wire.ts",
    layer: "basicPickerExtensions",
    platforms: ALL,
    comments: "c",
    kind: "ext",
    extract: listExtract({
      anchor: /const BASIC_ARCHIVE_EXTENSIONS = /,
      label: "BASIC_ARCHIVE_EXTENSIONS",
    }),
  },
  {
    id: "open-routing-rs",
    file: "src-tauri/src/launch/open_routing.rs",
    layer: "openRouting",
    platforms: ALL,
    comments: "c",
    kind: "ext",
    extract: listExtract({
      within: {
        anchor: /fn looks_like_archive_extension\(/,
        label: "fn looks_like_archive_extension",
      },
      anchor: /let extensions: &\[&str\] = /,
      label: "looks_like_archive_extension extensions",
    }),
  },
  {
    id: "open-routing-split-marker",
    file: "src-tauri/src/launch/open_routing.rs",
    layer: "splitVolumeDetection",
    formatId: "split-volume",
    platforms: ALL,
    comments: "c",
    kind: "marker",
    extract: markerExtract({
      anchor: /fn looks_like_split_volume_path\(/,
      label: "looks_like_split_volume_path",
      pattern: /suffix\s*!=\s*"001"/,
    }),
  },
  {
    id: "open-path-rs",
    file: "src-tauri/src/launch/open_path.rs",
    layer: "extractFolderSuffixes",
    platforms: ALL,
    comments: "c",
    kind: "ext",
    ordered: true,
    extract: listExtract({
      within: {
        anchor: /fn derive_extract_folder_name\(/,
        label: "fn derive_extract_folder_name",
      },
      anchor: /const SUFFIXES: &\[&str\] = /,
      label: "derive_extract_folder_name SUFFIXES",
    }),
  },
  {
    id: "extract-path-ts",
    file: "src/extract-path.ts",
    layer: "extractFolderSuffixes",
    platforms: ALL,
    comments: "c",
    kind: "ext",
    ordered: true,
    extract: listExtract({
      anchor: /const KNOWN_ARCHIVE_SUFFIXES = /,
      label: "KNOWN_ARCHIVE_SUFFIXES",
    }),
  },
  {
    id: "staging-rs-compound",
    file: "src-tauri/src/process/staging.rs",
    layer: "compoundTarSuffixes",
    platforms: ALL,
    comments: "c",
    kind: "ext",
    extract: arrayContainingExtract({
      anchor: /fn prepare_cleanup_plan_inner\b/,
      label: "compound TAR suffix list in prepare_cleanup_plan_inner",
      marker: '".tar.gz"',
    }),
  },
  {
    id: "commands-rs-compound",
    file: "src-tauri/src/process/commands.rs",
    layer: "compoundTarSuffixes",
    platforms: ALL,
    comments: "c",
    kind: "ext",
    extract: arrayContainingExtract({
      anchor: /pub\(crate\) fn is_compound_tar_operation\(/,
      label: "compound TAR suffix list in is_compound_tar_operation",
      marker: '".tar.gz"',
    }),
  },
  {
    id: "validation-rs-compound",
    file: "src-tauri/src/validation.rs",
    layer: "compoundTarSuffixes",
    platforms: ALL,
    comments: "c",
    kind: "ext",
    extract: arrayContainingExtract({
      anchor: /pub fn validate_run_7z_args\(/,
      label: "compound TAR suffix list in validate_run_7z_args",
      marker: '".tar.gz"',
    }),
  },
  {
    id: "args-ts-compound",
    file: "src/archive/args.ts",
    layer: "compoundTarSuffixes",
    platforms: ALL,
    comments: "c",
    kind: "ext",
    extract: listExtract({
      anchor: /const COMPOUND_TAR_SUFFIXES = /,
      label: "COMPOUND_TAR_SUFFIXES",
    }),
  },
  {
    id: "args-ts-create",
    file: "src/archive/args.ts",
    layer: "createOutput",
    platforms: ALL,
    comments: "c",
    kind: "keyed",
    extract: keyedExtract,
  },
  {
    id: "finder-sync-set",
    file: "src-tauri/macos/ZinniaFinderSync/FinderSync.swift",
    layer: "finderSyncArchiveExtensions",
    platforms: MAC,
    comments: "c",
    kind: "ext",
    extract: listExtract({
      anchor: /private let archiveExtensions: Set<String> = /,
      label: "FinderSync archiveExtensions",
    }),
  },
  {
    id: "finder-sync-compound",
    file: "src-tauri/macos/ZinniaFinderSync/FinderSync.swift",
    layer: "compoundTarSuffixes",
    platforms: MAC,
    comments: "c",
    kind: "ext",
    extract: hasSuffixExtract({
      anchor: /private func isArchiveURL\(/,
      label: "FinderSync isArchiveURL compound suffixes",
    }),
  },
  {
    id: "finder-sync-split-marker",
    file: "src-tauri/macos/ZinniaFinderSync/FinderSync.swift",
    layer: "splitVolumeDetection",
    formatId: "split-volume",
    platforms: MAC,
    comments: "c",
    kind: "marker",
    extract: markerExtract({
      anchor: /private func isArchiveURL\(/,
      label: "FinderSync isArchiveURL",
      pattern: /ext\s*==\s*"001"/,
    }),
  },
  {
    id: "dllmain-kexts",
    file: "src-tauri/windows/shell/dllmain.cpp",
    layer: "windowsShellArchiveExtensions",
    platforms: WIN,
    comments: "c",
    kind: "ext",
    extract: listExtract({
      within: {
        anchor: /static bool LooksLikeArchiveExtension\(/,
        label: "fn LooksLikeArchiveExtension",
      },
      anchor: /static const wchar_t\* kExts\[\] = /,
      open: "{",
      label: "LooksLikeArchiveExtension kExts",
      literal: WIDE_STRING,
    }),
  },
  {
    id: "dllmain-split-marker",
    file: "src-tauri/windows/shell/dllmain.cpp",
    layer: "splitVolumeDetection",
    formatId: "split-volume",
    platforms: WIN,
    comments: "c",
    kind: "marker",
    extract: markerExtract({
      anchor: /static bool LooksLikeSplitVolume\(/,
      label: "LooksLikeSplitVolume",
      pattern: /suffix\s*!=\s*L"001"/,
    }),
  },
  {
    id: "nsis-classic-register",
    file: "src-tauri/windows/nsis-hooks.nsh",
    layer: "windowsClassicArchiveVerbs",
    platforms: WIN,
    comments: "none",
    kind: "ext",
    extract: nsisCallsExtract("ZINNIA_REGISTER_CLASSIC_EXTRACT"),
  },
  {
    id: "nsis-classic-cleanup",
    file: "src-tauri/windows/nsis-hooks.nsh",
    layer: "windowsClassicArchiveVerbs",
    platforms: WIN,
    comments: "none",
    kind: "ext",
    extract: nsisCallsExtract("ZINNIA_CLEAN_LEGACY_ARCHIVE_VERBS"),
  },
  {
    id: "nsis-classic-unregister",
    file: "src-tauri/windows/nsis-hooks.nsh",
    layer: "windowsClassicArchiveVerbs",
    platforms: WIN,
    comments: "none",
    kind: "ext",
    extract: nsisCallsExtract("ZINNIA_UNREGISTER_ARCHIVE_VERBS"),
  },
  {
    id: "nsis-progid-open",
    file: "src-tauri/windows/nsis-hooks.nsh",
    layer: "windowsProgIdOpenVerb",
    platforms: WIN,
    comments: "none",
    kind: "ext",
    extract: nsisCallsExtract("ZINNIA_REGISTER_PROGID_OPEN"),
  },
  {
    id: "win11-appx-extract",
    file: "src-tauri/windows/sparse-package/ExtractAppxManifest.xml.template",
    layer: "win11ExtractMenuItemTypes",
    platforms: WIN,
    comments: "xml",
    kind: "ext",
    extract: appxItemTypesExtract,
  },
  {
    id: "tauri-windows-associations",
    file: "src-tauri/tauri.windows.conf.json",
    layer: "fileAssociation",
    platforms: WIN,
    comments: "none",
    kind: "ext-mime",
    extract: tauriAssociationsExtract("bundle.fileAssociations (windows)"),
  },
  {
    id: "tauri-macos-associations",
    file: "src-tauri/tauri.macos.conf.json",
    layer: "fileAssociation",
    platforms: MAC,
    comments: "none",
    kind: "ext-mime",
    extract: tauriAssociationsExtract("bundle.fileAssociations (macos)"),
  },
  {
    id: "tauri-linux-associations",
    file: "src-tauri/tauri.linux.conf.json",
    layer: "fileAssociation",
    platforms: LIN,
    comments: "none",
    kind: "ext-mime",
    extract: tauriAssociationsExtract("bundle.fileAssociations (linux)"),
  },
  {
    id: "tauri-base-associations",
    file: "src-tauri/tauri.conf.json",
    layer: "fileAssociationBase",
    platforms: ALL,
    comments: "none",
    kind: "ext-mime",
    extract: tauriAssociationsExtract("bundle.fileAssociations (base)"),
  },
  {
    id: "linux-desktop-mime",
    file: "run.rosie.zinnia.desktop",
    layer: "linuxMimeTypes",
    platforms: LIN,
    comments: "none",
    kind: "mime",
    extract: desktopMimeExtract,
  },
  {
    id: "linux-desktop-template-mime",
    file: "src-tauri/linux/desktop-template.hbs",
    layer: "linuxMimeTypes",
    platforms: LIN,
    comments: "none",
    kind: "mime",
    extract: desktopMimeExtract,
  },
  {
    id: "linux-metainfo-mime",
    file: "run.rosie.zinnia.metainfo.xml",
    layer: "linuxMimeTypes",
    platforms: LIN,
    comments: "xml",
    kind: "mime",
    extract: metainfoMimeExtract,
  },
  {
    id: "default-handler-targets",
    file: "src-tauri/src/platform/mod.rs",
    layer: "defaultHandlerTargets",
    platforms: ALL,
    comments: "c",
    kind: "ext-mime",
    extract: defaultTargetsExtract,
  },
  {
    id: "archive-detect-families",
    file: "src-tauri/src/archive_detect.rs",
    layer: null,
    what: "detectFamily",
    platforms: ALL,
    comments: "c",
    kind: "pairs",
    extract: familyPairsExtract,
  },
  {
    id: "archive-snapshot-split-bases",
    file: "src-tauri/src/process/archive_snapshot.rs",
    layer: "splitBaseSuffixes",
    platforms: ALL,
    comments: "c",
    kind: "ext",
    extract: listExtract({
      within: {
        anchor: /pub\(super\) fn archive_input_family\(/,
        label: "fn archive_input_family",
      },
      anchor: /const KNOWN_ARCHIVE_SUFFIXES: &\[&str\] = /,
      label: "archive_snapshot KNOWN_ARCHIVE_SUFFIXES",
    }),
  },
  {
    id: "flatpak-compound-mime",
    file: "scripts/validate-flatpak-dry-run.js",
    layer: null,
    what: "mimeType",
    platforms: ALL,
    comments: "c",
    kind: "ext-mime",
    extract: flatpakMimeExtract,
  },
];

// ---------- manifest loading and validation ----------

function readSource(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch (err) {
    throw new ParseError(`could not read ${rel} (${err.code ?? err.message})`);
  }
}

function normalizeSuffix(raw) {
  return raw.startsWith(".") ? raw : `.${raw}`;
}

function isMember(format, layer, platform) {
  const value = format.layers[layer];
  return typeof value === "boolean" ? value : value[platform];
}

function validateManifest(raw) {
  const errors = [];
  const fail = (msg) => errors.push(`archive-formats: ${MANIFEST}: ${msg}`);
  if (!raw || typeof raw !== "object") {
    fail("top level must be a JSON object");
    return errors;
  }
  if (raw.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!raw.layers || typeof raw.layers !== "object") {
    fail("layers must be an object");
    return errors;
  }
  const layerNames = new Set(Object.keys(raw.layers));
  for (const [name, def] of Object.entries(raw.layers)) {
    if (typeof def?.description !== "string" || def.description.length === 0) {
      fail(`layer "${name}" needs a description`);
    }
  }
  if (!Array.isArray(raw.formats) || raw.formats.length === 0) {
    fail("formats must be a non-empty array");
    return errors;
  }
  const ids = new Set();
  const exts = new Set();
  for (const format of raw.formats) {
    const id = format?.id;
    if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id)) {
      fail(`format id "${id}" must match ^[a-z0-9-]+$`);
      continue;
    }
    if (ids.has(id)) fail(`duplicate format id "${id}"`);
    ids.add(id);
    if (!Array.isArray(format.extensions) || format.extensions.length === 0) {
      fail(`format "${id}" needs an extensions array`);
    } else {
      for (const ext of format.extensions) {
        if (typeof ext !== "string" || !/^\.[a-z0-9.]+$/.test(ext)) {
          fail(
            `format "${id}" extension "${ext}" must be lowercase with a leading dot`,
          );
        } else if (exts.has(ext)) {
          fail(`extension "${ext}" is listed by more than one format`);
        }
        exts.add(ext);
      }
    }
    if (format.mimeType !== null && typeof format.mimeType !== "string") {
      fail(`format "${id}" mimeType must be a string or null`);
    }
    if (
      format.detectFamily !== null &&
      typeof format.detectFamily !== "string"
    ) {
      fail(`format "${id}" detectFamily must be a string or null`);
    }
    if (
      typeof format.description !== "string" ||
      format.description.length === 0
    ) {
      fail(`format "${id}" needs a description`);
    }
    const memberships = format.layers ?? {};
    for (const layer of layerNames) {
      if (!(layer in memberships))
        fail(`format "${id}" is missing layer "${layer}"`);
    }
    for (const [layer, value] of Object.entries(memberships)) {
      if (!layerNames.has(layer)) {
        fail(`format "${id}" sets unknown layer "${layer}"`);
        continue;
      }
      if (typeof value === "boolean") continue;
      const keys = value && typeof value === "object" ? Object.keys(value) : [];
      const exact =
        keys.length === PLATFORMS.length &&
        keys.every((k) => PLATFORM_KEYS.has(k));
      if (!exact || PLATFORMS.some((p) => typeof value[p] !== "boolean")) {
        fail(
          `format "${id}" layer "${layer}" must be a boolean or {windows, macos, linux} booleans`,
        );
      }
    }
  }
  if (!Array.isArray(raw.asymmetries)) {
    fail("asymmetries must be an array");
  } else {
    for (const asym of raw.asymmetries) {
      if (asym.layer !== null && !layerNames.has(asym.layer)) {
        fail(`asymmetry references unknown layer "${asym.layer}"`);
      }
      for (const id of asym.formats ?? []) {
        if (!ids.has(id)) fail(`asymmetry references unknown format "${id}"`);
      }
      if (typeof asym.note !== "string" || asym.note.length === 0)
        fail("asymmetry needs a note");
    }
  }
  return errors;
}

// ---------- per-location evaluation ----------

function evalExt(loc, items, ctx) {
  const structural = [];
  const ids = new Set();
  const exts = [];
  const seen = new Set();
  for (const raw of items) {
    if (raw !== raw.toLowerCase())
      structural.push(`entry "${raw}" is not lowercase`);
    const ext = normalizeSuffix(raw.toLowerCase());
    exts.push(ext);
    if (seen.has(ext)) structural.push(`duplicate entry "${raw}"`);
    seen.add(ext);
    const format = ctx.byExt.get(ext);
    if (format) ids.add(format.id);
    else
      structural.push(
        `unknown extension "${raw}" (no format in ${MANIFEST}; add it there or remove it)`,
      );
  }
  if (loc.ordered) {
    for (let i = 0; i < exts.length; i++) {
      for (let j = i + 1; j < exts.length; j++) {
        if (exts[j] !== exts[i] && exts[j].endsWith(exts[i])) {
          structural.push(
            `"${exts[i]}" is listed before "${exts[j]}"; longer suffixes must come first`,
          );
        }
      }
    }
  }
  return { structural, ids };
}

function evalExtMime(loc, items, ctx) {
  const structural = [];
  const ids = new Set();
  const seen = new Set();
  for (const item of items) {
    const raw = String(item.ext);
    if (raw !== raw.toLowerCase())
      structural.push(`entry "${raw}" is not lowercase`);
    const ext = normalizeSuffix(raw.toLowerCase());
    if (seen.has(ext)) structural.push(`duplicate entry "${raw}"`);
    seen.add(ext);
    const format = ctx.byExt.get(ext);
    if (!format) {
      structural.push(
        `unknown extension "${raw}" (no format in ${MANIFEST}; add it there or remove it)`,
      );
      continue;
    }
    ids.add(format.id);
    if (item.mime !== format.mimeType) {
      structural.push(
        `MIME for ${ext} is "${item.mime}"; ${MANIFEST} says "${format.mimeType}"`,
      );
    }
    if (item.key !== undefined && item.key !== format.id) {
      structural.push(
        `key "${item.key}" does not match format id "${format.id}"`,
      );
    }
  }
  return { structural, ids };
}

function evalKeyed(items, ctx) {
  const structural = [];
  const ids = new Set();
  for (const item of items) {
    const format = ctx.byId.get(item.key);
    if (!format) {
      structural.push(`key "${item.key}" is not a format id in ${MANIFEST}`);
      continue;
    }
    ids.add(format.id);
    const expected = JSON.stringify([format.extensions[0]]);
    if (JSON.stringify(item.values) !== expected) {
      structural.push(
        `${item.key} lists ${JSON.stringify(item.values)}; ${MANIFEST} says ${expected}`,
      );
    }
  }
  return { structural, ids };
}

function evalMime(items, ctx) {
  const structural = [];
  const mimes = new Set();
  const known = new Set(ctx.formats.map((f) => f.mimeType).filter(Boolean));
  for (const raw of items) {
    if (mimes.has(raw)) structural.push(`duplicate MIME "${raw}"`);
    mimes.add(raw);
    if (!known.has(raw))
      structural.push(`unknown MIME "${raw}" (no format in ${MANIFEST})`);
  }
  return { structural, mimes };
}

function evalPairs(items, ctx) {
  const structural = [];
  const actual = new Map();
  for (const { ext, family } of items) {
    const e = normalizeSuffix(ext.toLowerCase());
    if (ext !== ext.toLowerCase())
      structural.push(`entry "${ext}" is not lowercase`);
    if (!ctx.byExt.has(e)) {
      structural.push(
        `unknown extension "${ext}" in expected_archive_family (no format in ${MANIFEST})`,
      );
      continue;
    }
    if (actual.has(e)) structural.push(`duplicate arm for "${ext}"`);
    actual.set(e, family);
  }
  const expected = new Map(
    ctx.formats
      .filter((f) => f.detectFamily)
      .map((f) => [f.extensions[0], f.detectFamily]),
  );
  const lines = [];
  for (const [e, family] of expected) {
    if (!actual.has(e))
      lines.push(
        `    - ${e}: ${MANIFEST} says family "${family}"; source has no arm`,
      );
    else if (actual.get(e) !== family) {
      lines.push(
        `    ~ ${e}: source says "${actual.get(e)}"; ${MANIFEST} says "${family}"`,
      );
    }
  }
  for (const [e, family] of actual) {
    if (!expected.has(e))
      lines.push(
        `    + ${e}: source says family "${family}"; ${MANIFEST} says none`,
      );
  }
  return { structural, lines };
}

// Records one diff block per platform; identical blocks are merged later.
function addDiff(diffs, platform, lines) {
  if (!diffs.has(platform)) diffs.set(platform, []);
  diffs.get(platform).push(...lines);
}

function membershipLines(layer, platform, ids, ctx) {
  const lines = [];
  const expected = ctx.formats.filter((f) => isMember(f, layer, platform));
  const expectedIds = new Set(expected.map((f) => f.id));
  for (const f of expected) {
    if (!ids.has(f.id)) {
      lines.push(
        `    - ${f.extensions[0]} (${f.id}): ${MANIFEST} lists it on ${platform}; source omits it`,
      );
    }
  }
  for (const id of ids) {
    if (!expectedIds.has(id)) {
      const f = ctx.byId.get(id);
      lines.push(
        `    + ${f.extensions[0]} (${id}): source lists it; ${MANIFEST} does not list it on ${platform}`,
      );
    }
  }
  return lines;
}

function mimeLines(layer, platform, mimes, ctx) {
  const lines = [];
  const expected = new Set(
    ctx.formats
      .filter((f) => isMember(f, layer, platform) && f.mimeType)
      .map((f) => f.mimeType),
  );
  for (const m of expected) {
    if (!mimes.has(m))
      lines.push(
        `    - ${m}: ${MANIFEST} lists it on ${platform}; source omits it`,
      );
  }
  for (const m of mimes) {
    if (!expected.has(m))
      lines.push(
        `    + ${m}: source lists it; ${MANIFEST} does not list it on ${platform}`,
      );
  }
  return lines;
}

function markerLines(loc, platform, present, ctx) {
  const format = ctx.byId.get(loc.formatId);
  const expected = isMember(format, loc.layer, platform);
  if (expected === present) return [];
  return [
    `    split-volume detection marker is ${present ? "present" : "absent"} in source; ` +
      `${MANIFEST} says ${expected ? "detected" : "not detected"} on ${platform}`,
  ];
}

function evaluate(loc, result, ctx) {
  const diffs = new Map();
  const structural = [];
  if (loc.kind === "ext") {
    const r = evalExt(loc, result.items, ctx);
    structural.push(...r.structural);
    for (const p of loc.platforms)
      addDiff(diffs, p, membershipLines(loc.layer, p, r.ids, ctx));
  } else if (loc.kind === "ext-mime") {
    const r = evalExtMime(loc, result.items, ctx);
    structural.push(...r.structural);
    if (loc.layer) {
      for (const p of loc.platforms)
        addDiff(diffs, p, membershipLines(loc.layer, p, r.ids, ctx));
    }
  } else if (loc.kind === "keyed") {
    const r = evalKeyed(result.items, ctx);
    structural.push(...r.structural);
    for (const p of loc.platforms)
      addDiff(diffs, p, membershipLines(loc.layer, p, r.ids, ctx));
  } else if (loc.kind === "mime") {
    const r = evalMime(result.items, ctx);
    structural.push(...r.structural);
    for (const p of loc.platforms)
      addDiff(diffs, p, mimeLines(loc.layer, p, r.mimes, ctx));
  } else if (loc.kind === "marker") {
    for (const p of loc.platforms)
      addDiff(diffs, p, markerLines(loc, p, result.present, ctx));
  } else if (loc.kind === "pairs") {
    const r = evalPairs(result.items, ctx);
    structural.push(...r.structural);
    addDiff(diffs, "*", r.lines);
  }
  return { structural, diffs };
}

function formatProblems(loc, outcome) {
  const problems = [];
  const label = loc.layer ? `layer "${loc.layer}"` : loc.what;
  for (const msg of outcome.structural) {
    problems.push(
      `archive-formats: ${loc.file} (${loc.layer ?? loc.what}): ${msg}`,
    );
  }
  const groups = new Map();
  for (const [platform, lines] of outcome.diffs) {
    if (lines.length === 0) continue;
    const key = lines.join("\n");
    if (!groups.has(key)) groups.set(key, { platforms: [], lines });
    groups.get(key).platforms.push(platform);
  }
  for (const group of groups.values()) {
    const where = group.platforms.includes("*")
      ? ""
      : ` on ${group.platforms.join(", ")}`;
    problems.push(
      `archive-formats: ${label} disagrees with ${loc.file}${where}\n${group.lines.join("\n")}`,
    );
  }
  return problems;
}

// ---------- driver ----------

function runChecks(root) {
  const problems = [];
  const locationReports = [];
  let manifest;
  try {
    manifest = JSON.parse(readSource(root, MANIFEST));
  } catch (err) {
    if (err instanceof ParseError) throw err;
    throw new ParseError(`could not parse ${MANIFEST} as JSON: ${err.message}`);
  }
  const manifestErrors = validateManifest(manifest);
  if (manifestErrors.length > 0) {
    return { problems: manifestErrors, locationReports, manifest };
  }
  const ctx = {
    formats: manifest.formats,
    byId: new Map(manifest.formats.map((f) => [f.id, f])),
    byExt: new Map(
      manifest.formats.flatMap((f) => f.extensions.map((e) => [e, f])),
    ),
  };
  const layerNames = Object.keys(manifest.layers);
  const coverage = new Map(layerNames.map((name) => [name, new Set()]));
  const unreadableLayers = new Set();

  for (const loc of LOCATIONS) {
    let text;
    let result;
    try {
      text = stripComments(readSource(root, loc.file), loc.comments);
      result = loc.extract(text, loc.file);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      problems.push(`archive-formats: ${err.message}`);
      locationReports.push({ id: loc.id, file: loc.file, error: err.message });
      if (loc.layer !== null) unreadableLayers.add(loc.layer);
      continue;
    }
    if (loc.layer !== null && !coverage.has(loc.layer)) {
      problems.push(
        `archive-formats: checker location "${loc.id}" names unknown layer "${loc.layer}"`,
      );
      continue;
    }
    const outcome = evaluate(loc, result, ctx);
    problems.push(...formatProblems(loc, outcome));
    if (loc.layer !== null)
      for (const p of loc.platforms) coverage.get(loc.layer).add(p);
    locationReports.push({
      id: loc.id,
      file: loc.file,
      layer: loc.layer,
      platforms: loc.platforms,
      kind: loc.kind,
      items: result.items ?? result.present,
      problems: formatProblems(loc, outcome),
    });
  }

  // Every platform a layer claims must have a source list, and every layer needs one.
  for (const layer of layerNames) {
    if (unreadableLayers.has(layer)) continue;
    const covered = coverage.get(layer);
    if (covered.size === 0) {
      problems.push(
        `archive-formats: layer "${layer}" has no source location in the checker`,
      );
      continue;
    }
    for (const p of PLATFORMS) {
      if (covered.has(p)) continue;
      const claimed = manifest.formats
        .filter((f) => isMember(f, layer, p))
        .map((f) => f.id);
      if (claimed.length > 0) {
        problems.push(
          `archive-formats: layer "${layer}" lists ${claimed.join(", ")} on ${p}, but no source list covers ${p}`,
        );
      }
    }
  }
  return { problems, locationReports, manifest };
}

function parseArgs(argv) {
  const options = { root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--root") {
      const value = argv[++i];
      if (!value) throw new UsageError("--root needs a directory");
      options.root = path.resolve(value);
    } else if (arg.startsWith("--root="))
      options.root = path.resolve(arg.slice("--root=".length));
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`archive-formats: ${err.message}`);
      console.error(
        "usage: node scripts/check-archive-formats.mjs [--root <dir>] [--json]",
      );
      return 2;
    }
    throw err;
  }
  let result;
  try {
    result = runChecks(options.root);
  } catch (err) {
    if (err instanceof ParseError) {
      console.error(`archive-formats: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const { problems, locationReports, manifest } = result;
  if (options.json) {
    const out = {
      root: options.root,
      ok: problems.length === 0,
      formats: manifest.formats?.map((f) => f.id) ?? [],
      layers: Object.keys(manifest.layers ?? {}),
      locations: locationReports,
      problems,
    };
    console.log(JSON.stringify(out, null, 2));
  }
  if (problems.length > 0) {
    if (!options.json) for (const problem of problems) console.error(problem);
    console.error(`archive-formats: FAILED with ${problems.length} problem(s)`);
    return 1;
  }
  if (!options.json) {
    console.log(
      `archive-formats: OK (${manifest.formats.length} formats, ${Object.keys(manifest.layers).length} layers, ` +
        `${LOCATIONS.length} source lists, ${PLATFORMS.length} platforms)`,
    );
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`archive-formats: internal error: ${err?.stack ?? err}`);
  process.exitCode = 1;
}
