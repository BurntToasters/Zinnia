import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../scripts/update-metainfo.js";

const temporaryDirectories: string[] = [];

function fixture(
  version: string,
  releases: string,
): {
  packagePath: string;
  metadataPath: string;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zinnia-metainfo-"));
  temporaryDirectories.push(directory);
  const packagePath = path.join(directory, "package.json");
  const metadataPath = path.join(directory, "metainfo.xml");
  fs.writeFileSync(packagePath, JSON.stringify({ version }));
  fs.writeFileSync(
    metadataPath,
    `<component>\n  <releases>\n    ${releases}\n  </releases>\n</component>\n`,
  );
  return { packagePath, metadataPath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("update-metainfo", () => {
  it("preserves the historical date of an existing version", () => {
    const paths = fixture(
      "0.6.0-beta.4",
      '<release version="0.6.0-beta.4" date="2026-07-20"/>',
    );

    const result = run({
      ...paths,
      now: new Date("2026-07-25T12:00:00Z"),
    });

    expect(result).toEqual({
      updated: false,
      version: "0.6.0-beta.4",
      date: "2026-07-20",
    });
    expect(fs.readFileSync(paths.metadataPath, "utf8")).toContain(
      'date="2026-07-20"',
    );
  });

  it("adds a dated entry for a new version", () => {
    const paths = fixture(
      "0.6.0-beta.5",
      '<release version="0.6.0-beta.4" date="2026-07-20"/>',
    );

    expect(
      run({ ...paths, now: new Date("2026-07-25T12:00:00Z") }).updated,
    ).toBe(true);
    const metadata = fs.readFileSync(paths.metadataPath, "utf8");
    expect(metadata).toContain(
      '<release version="0.6.0-beta.5" date="2026-07-25"/>',
    );
    expect(metadata.indexOf("0.6.0-beta.5")).toBeLessThan(
      metadata.indexOf("0.6.0-beta.4"),
    );
  });

  it("requires new release metadata to be committed before release preparation", () => {
    const paths = fixture(
      "0.6.0-beta.5",
      '<release version="0.6.0-beta.4" date="2026-07-20"/>',
    );

    expect(() => run({ ...paths, check: true })).toThrow(
      "add and commit it before release preparation",
    );
  });
});
