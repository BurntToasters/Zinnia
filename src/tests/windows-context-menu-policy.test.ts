import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const manifestPath = path.resolve(
  process.cwd(),
  "src-tauri/windows/sparse-package/AppxManifest.xml.template",
);
const manifest = fs.readFileSync(manifestPath, "utf8");
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

function itemTypeBody(type: string): string {
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
  it("uses schema-valid base UAP file associations", () => {
    expect(manifest).toContain(
      '<uap:Extension Category="windows.fileTypeAssociation">',
    );
    expect(manifest).toContain(
      '<uap:FileTypeAssociation Name="zinnia-archives">',
    );
    expect(manifest).not.toMatch(/FileTypeAssociation[^>]*\bParameters=/);
    expect(manifest).not.toContain("<uap3:FileTypeAssociation");
  });

  it("keeps wildcard registration to one root verb", () => {
    const wildcard = itemTypeBody("*");
    expect(wildcard).toContain('Id="ZinniaRoot"');
    expect(wildcard).not.toContain("ZinniaExtract");
    expect(wildcard.match(/<desktop5:Verb\b/g)).toHaveLength(1);
  });

  it("registers one top-level extract verb for every supported archive type", () => {
    for (const type of supportedArchiveTypes) {
      const body = itemTypeBody(type);
      expect(body).toContain("ZinniaExtract");
      expect(body).not.toContain("ZinniaRoot");
      expect(body.match(/<desktop5:Verb\b/g)).toHaveLength(1);
      expect(manifest).toContain(`<uap:FileType>${type}</uap:FileType>`);
    }
  });

  it("keeps archive filtering fast on Explorer's menu-construction path", () => {
    expect(shellSource).toContain('stem_os + L".002"');
    expect(shellSource).not.toContain("volume <= 999");
  });
});
