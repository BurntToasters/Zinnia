import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARCHIVE_EXTENSIONS } from "../utils";
import type { ArchiveFormat } from "../settings-model";
import { deriveExtractFolderName } from "../extract-path";
import { SAFE_EXTRACT_OVERWRITE_MODE } from "../extract-policy";
import { buildExtractArgsFor } from "../archive";
import { buildSelectiveExtractArgs } from "../selective-extract";
import { validateArchiveOutputExtension } from "../archive/args";
import { state } from "../state";
import {
  APP_CREATE_PREFIX,
  APP_EXTRACT_SWITCHES,
  APP_LIST_SWITCHES,
  APP_TEST_SWITCHES,
  APP_UPDATE_SWITCHES,
  UPDATE_FORMATS,
  hardenFixture7zArgs,
  listingHasMember,
  parseSltMemberPaths,
} from "../../scripts/archive-fixtures.js";

interface ManifestExtractEntry {
  file: string;
  family: string;
  members: string[];
  password?: boolean;
  compoundTar?: boolean;
}

interface ManifestNegativeEntry {
  file: string;
  detect: boolean;
  extract: boolean;
}

interface ArchiveManifest {
  payloadFile: string;
  payloadText: string;
  password: string;
  create: ArchiveFormat[];
  extract: ManifestExtractEntry[];
  negative: ManifestNegativeEntry[];
}

const CREATE_FORMATS: ArchiveFormat[] = [
  "7z",
  "zip",
  "tar",
  "gzip",
  "bzip2",
  "xz",
];

function loadManifest(): ArchiveManifest {
  const raw = fs.readFileSync(
    path.resolve(process.cwd(), "zips", "manifest.json"),
    "utf8",
  );
  return JSON.parse(raw) as ArchiveManifest;
}

function fixtureSuffix(fileName: string): string {
  const lower = fileName.toLowerCase();
  const compounds = [".tar.gz", ".tar.bz2", ".tar.xz"];
  for (const suffix of compounds) {
    if (lower.endsWith(suffix)) return suffix.slice(suffix.lastIndexOf("."));
  }
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

describe("zips/ fixture manifest", () => {
  const manifest = loadManifest();

  it("keeps hello.txt in sync with the manifest payload", () => {
    const payload = fs.readFileSync(
      path.resolve(process.cwd(), "zips", manifest.payloadFile),
      "utf8",
    );
    expect(payload).toBe(manifest.payloadText);
  });

  it("lists the six create formats and no RAR write", () => {
    expect(manifest.create).toEqual(CREATE_FORMATS);
    expect(manifest.create).not.toContain("rar" as ArchiveFormat);
  });

  it("maps extract fixtures onto ARCHIVE_EXTENSIONS and folder-name suffixes", () => {
    for (const entry of manifest.extract) {
      expect(
        fs.existsSync(path.resolve(process.cwd(), "zips", entry.file)),
      ).toBe(true);
      expect(deriveExtractFolderName(entry.file).length).toBeGreaterThan(0);
      if (entry.file.startsWith("hello.")) {
        expect(deriveExtractFolderName(entry.file)).toBe("hello");
      }
      expect(ARCHIVE_EXTENSIONS.has(fixtureSuffix(entry.file))).toBe(true);
    }
  });

  it("limits password fixtures to 7z and zip", () => {
    const encrypted = manifest.extract.filter((entry) => entry.password);
    expect(encrypted.map((entry) => entry.file).sort()).toEqual([
      "encrypted-aes.zip",
      "encrypted.7z",
    ]);
    for (const entry of encrypted) {
      expect(["7z", "zip"]).toContain(entry.family);
    }
  });

  it("refuses compound TAR create destinations", () => {
    for (const dest of [
      "out.tar.gz",
      "out.tgz",
      "out.tar.bz2",
      "out.tbz2",
      "out.tar.xz",
      "out.txz",
    ]) {
      expect(validateArchiveOutputExtension(dest, "gzip")).toMatch(
        /compound TAR/i,
      );
    }
  });
});

describe("extract policy with fixture paths", () => {
  it("uses auto-rename overwrite for zips/hello.7z extract args", () => {
    (document.getElementById("extract-path") as HTMLInputElement).value =
      "/tmp/zips-extract";
    (document.getElementById("extract-password") as HTMLInputElement).value =
      "";
    (document.getElementById("extract-extra-args") as HTMLInputElement).value =
      "";
    state.inputs = [path.resolve(process.cwd(), "zips", "hello.7z")];
    const args = buildExtractArgsFor(state.inputs[0]);
    expect(args[0]).toBe("x");
    expect(args).toContain(SAFE_EXTRACT_OVERWRITE_MODE);
    expect(args).toContain(state.inputs[0]);
    for (const flag of APP_EXTRACT_SWITCHES) {
      expect(args).toContain(flag);
    }
  });
});

describe("archive fixture helpers match app 7-Zip switches", () => {
  it("keeps extract/list/test/update/create prefixes aligned with the UI", () => {
    expect(APP_EXTRACT_SWITCHES).toEqual(["-aou", "-bb1", "-spd", "-bsp1"]);
    expect(APP_LIST_SWITCHES).toEqual(["l", "-slt", "-spd"]);
    expect(APP_TEST_SWITCHES).toEqual(["t", "-spd"]);
    expect(APP_UPDATE_SWITCHES).toEqual(["u", "-sse", "-snl", "-snh", "-spd"]);
    expect(APP_CREATE_PREFIX).toEqual(["-sse", "-snl", "-snh", "-spd"]);
    expect(UPDATE_FORMATS).toEqual(["7z", "zip", "tar"]);
    expect(
      buildSelectiveExtractArgs("/tmp/a.7z", "/tmp/out", "", [], []),
    ).toEqual(
      expect.arrayContaining(["x", ...APP_EXTRACT_SWITCHES, "--", "/tmp/a.7z"]),
    );
  });

  it("parses 7-Zip slt member paths and ignores the archive header Path", () => {
    const stdout = [
      "--",
      "Path = /tmp/hello.zip",
      "Type = zip",
      "----------",
      "Path = nested/hello.txt",
      "Size = 12",
      "",
      "Path = héllo.txt",
      "Size = 12",
      "",
    ].join("\n");
    expect(parseSltMemberPaths(stdout)).toEqual([
      "nested/hello.txt",
      "héllo.txt",
    ]);
    expect(listingHasMember(stdout, "nested/hello.txt")).toBe(true);
    expect(listingHasMember(stdout, "nested\\hello.txt")).toBe(true);
    expect(listingHasMember(stdout, "héllo.txt")).toBe(true);
    expect(listingHasMember(stdout, "missing.txt")).toBe(false);
    expect(listingHasMember(stdout, "hello.txt")).toBe(false);
  });

  it("injects Windows -sccUTF-8 the same way harden_7z_args does", () => {
    expect(
      hardenFixture7zArgs(["l", "-slt", "-spd", "--", "a.zip"], "win32"),
    ).toEqual(["l", "-sccUTF-8", "-slt", "-spd", "--", "a.zip"]);
    expect(
      hardenFixture7zArgs(["l", "-sccUTF-8", "-slt", "-spd"], "win32"),
    ).toEqual(["l", "-sccUTF-8", "-slt", "-spd"]);
    expect(hardenFixture7zArgs(["l", "-slt", "-spd"], "linux")).toEqual([
      "l",
      "-slt",
      "-spd",
    ]);
  });

  it("keeps test-archives covering list, add, selective extract, convert, and password denial", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "scripts", "test-archives.js"),
      "utf8",
    );
    expect(src).toContain("testIntegrityListExtract");
    expect(src).toContain("testEncryptedDeniedWithoutPassword");
    expect(src).toContain("testAddToExisting");
    expect(src).toContain("testSelectiveExtract");
    expect(src).toContain("testConvertRoundtrip");
    expect(src).toContain("APP_LIST_SWITCHES");
    expect(src).toContain("APP_UPDATE_SWITCHES");
  });
});
