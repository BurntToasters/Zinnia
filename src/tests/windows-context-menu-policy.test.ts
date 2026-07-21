import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootManifestPath = path.resolve(
  process.cwd(),
  "src-tauri/windows/sparse-package/AppxManifest.xml.template",
);
const extractManifestPath = path.resolve(
  process.cwd(),
  "src-tauri/windows/sparse-package/ExtractAppxManifest.xml.template",
);
const rootManifest = fs.readFileSync(rootManifestPath, "utf8");
const extractManifest = fs.readFileSync(extractManifestPath, "utf8");
const shellSource = fs.readFileSync(
  path.resolve(process.cwd(), "src-tauri/windows/shell/dllmain.cpp"),
  "utf8",
);
const supportedArchiveTypes = [
  ".7z",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".tbz2",
  ".xz",
  ".txz",
  ".001",
];

function itemTypeBody(manifest: string, type: string): string {
  const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = manifest.match(
    new RegExp(
      `<desktop5:ItemType Type="${escaped}">([\\s\\S]*?)<\\/desktop5:ItemType>`,
    ),
  );
  expect(match, `missing ItemType ${type}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("Windows 11 context-menu manifest", () => {
  it("separates Root and Extract into distinct app identities", () => {
    expect(rootManifest).toContain('Name="run.rosie.zinnia.contextmenu"');
    expect(extractManifest).toContain('Name="run.rosie.zinnia.extractmenu"');
    expect(rootManifest).not.toContain("ZinniaExtract");
    expect(extractManifest).not.toContain("ZinniaRoot");
    expect(extractManifest).toContain('Path="zinnia_extract_shell.dll"');
  });

  it("does not register the extraction command as a file opener", () => {
    expect(extractManifest).not.toContain("windows.fileTypeAssociation");
    expect(extractManifest).not.toContain("FileTypeAssociation");
    expect(extractManifest).not.toContain("SupportedFileTypes");
  });

  it("keeps wildcard registration to one root verb", () => {
    const wildcard = itemTypeBody(rootManifest, "*");
    expect(wildcard).toContain('Id="ZinniaRoot"');
    expect(wildcard).not.toContain("ZinniaExtract");
    expect(wildcard.match(/<desktop5:Verb\b/g)).toHaveLength(1);
  });

  it("registers one top-level extract verb for every supported archive type", () => {
    for (const type of supportedArchiveTypes) {
      const body = itemTypeBody(extractManifest, type);
      expect(body).toContain("ZinniaExtract");
      expect(body).not.toContain("ZinniaRoot");
      expect(body.match(/<desktop5:Verb\b/g)).toHaveLength(1);
    }
  });

  it("builds, bundles, signs, and registers both sparse packages", () => {
    const read = (file: string) =>
      fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
    const build = read("scripts/build-windows-context-menu.ps1");
    const stubs = read("scripts/ensure-windows-context-menu-stubs.mjs");
    const tauriBuild = read("scripts/tauri-windows-build.js");
    const verify = read("scripts/verify-windows-authenticode.ps1");
    const sign = read("scripts/windows-artifact-sign.ps1");
    const tauriConfig = read("src-tauri/tauri.windows.conf.json");
    const packageConsumers = [
      build,
      stubs,
      tauriBuild,
      verify,
      sign,
      tauriConfig,
    ];

    for (const contents of packageConsumers) {
      expect(contents).toContain("ZinniaContextMenu.msix");
      expect(contents).toContain("ZinniaExtractContextMenu.msix");
    }
    for (const contents of [build, stubs, tauriBuild, verify, tauriConfig]) {
      expect(contents).toContain("zinnia_shell.dll");
      expect(contents).toContain("zinnia_extract_shell.dll");
    }

    const registration = read("scripts/register-windows-context-menu.ps1");
    expect(registration).toContain("$MsixPath");
    expect(registration).toContain("$ExtractMsixPath");
    expect(registration).toContain("run.rosie.zinnia.contextmenu");
    expect(registration).toContain("run.rosie.zinnia.extractmenu");
  });

  it("keeps archive filtering fast on Explorer's menu-construction path", () => {
    expect(shellSource).toContain('stem_os + L".002"');
    expect(shellSource).not.toContain("volume <= 999");
  });
});
