import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { expectedReleaseBranch } from "../../scripts/release-preflight.js";

describe("release preflight policy", () => {
  it("wires source and quality gates into every release entry point", () => {
    const root = process.cwd();
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const testRunner = fs.readFileSync(
      path.join(root, "scripts", "test-all.js"),
      "utf8",
    );

    expect(packageJson.scripts["prerelease:prepare"]).toContain(
      "release:preflight",
    );
    expect(packageJson.scripts["release:prepare"]).toContain(
      "workspace:prepare",
    );
    expect(packageJson.scripts["release:prepare"]).toContain(
      "dist:clean-release-artifacts",
    );
    // Metainfo must be written before test:all (flatpak validates the version).
    const workspacePrepare = packageJson.scripts["workspace:prepare"];
    expect(workspacePrepare.indexOf("update-metainfo.js")).toBeLessThan(
      workspacePrepare.indexOf("test:all"),
    );
    // Branch/clean-tree gates stay on publish entry points only, not u/u2.
    expect(packageJson.scripts.u).toContain("workspace:prepare");
    expect(packageJson.scripts.u).not.toContain("release:prepare");
    expect(packageJson.scripts.u2).toContain("workspace:prepare");
    expect(packageJson.scripts.u2).not.toContain("release:prepare");
    expect(packageJson.scripts.u).not.toContain("release:preflight");
    expect(packageJson.scripts.u2).not.toContain("release:preflight");
    expect(packageJson.scripts["release:win"]).toContain("prerelease:prepare");
    expect(testRunner).toContain('"rustfmt"');
    expect(testRunner).toContain('"clippy"');
  });

  it("routes prereleases to beta and stable releases to main", () => {
    expect(expectedReleaseBranch("0.6.0-beta.10")).toBe("beta");
    expect(expectedReleaseBranch("0.6.0-rc.2")).toBe("beta");
    expect(expectedReleaseBranch("0.6.0")).toBe("main");
  });
});
