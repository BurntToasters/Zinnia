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
    const workspaceBootstrap = packageJson.scripts["workspace:bootstrap"];
    const workspacePrepare = packageJson.scripts["workspace:prepare"];
    expect(workspaceBootstrap).toContain("update-metainfo.js");
    expect(workspacePrepare).toContain("workspace:bootstrap");
    expect(workspacePrepare).toContain("test:all");
    expect(workspacePrepare.match(/test:all/g)).toHaveLength(1);
    expect(packageJson.scripts.u.match(/test:all/g)).toHaveLength(1);
    expect(packageJson.scripts.u).not.toContain("validate:updater");
    expect(packageJson.scripts.u2).toContain("workspace:bootstrap");
    expect(packageJson.scripts.u2).not.toContain("workspace:prepare");
    expect(packageJson.scripts.u2.match(/test:all/g)).toHaveLength(1);

    for (const platform of ["win", "mac"] as const) {
      const full = packageJson.scripts[`release:${platform}`];
      const resume = packageJson.scripts[`release:${platform}:resume`];
      const continuation = packageJson.scripts[`release:${platform}:continue`];
      expect(full.match(/npm run release:prepare/g)).toHaveLength(1);
      expect(full).toContain(`release:${platform}:continue`);
      expect(resume).toContain("prerelease:prepare");
      expect(resume).not.toContain("npm run release:prepare");
      expect(continuation).toContain("release:session:verify");
      expect(continuation).toContain(":prepared");
    }
    for (const architecture of ["x64", "arm64"] as const) {
      const full = packageJson.scripts[`release:linux:${architecture}`];
      const resume =
        packageJson.scripts[`release:linux:${architecture}:resume`];
      const continuation =
        packageJson.scripts[`release:linux:${architecture}:continue`];
      expect(full.match(/npm run release:prepare/g)).toHaveLength(1);
      expect(resume).not.toContain("npm run release:prepare");
      expect(continuation).toContain("release:session:verify");
      expect(continuation).toContain(":prepared");
    }

    expect(packageJson.scripts["build:win"]).toContain("build:win:prepared");
    expect(packageJson.scripts["build:win"].match(/licenses/g)).toHaveLength(1);
    // Branch/clean-tree gates stay on publish entry points only, not u/u2.
    expect(packageJson.scripts.u).toContain("workspace:bootstrap");
    expect(packageJson.scripts.u).not.toContain("release:prepare");
    expect(packageJson.scripts.u2).toContain("workspace:bootstrap");
    expect(packageJson.scripts.u2).not.toContain("release:prepare");
    expect(packageJson.scripts.u).not.toContain("release:preflight");
    expect(packageJson.scripts.u2).not.toContain("release:preflight");
    expect(packageJson.scripts["release:win"]).toContain("prerelease:prepare");
    expect(packageJson.scripts["release:session:verify"]).toContain(
      "release-session.js",
    );
    expect(testRunner).toContain('"rustfmt"');
    expect(testRunner).toContain('"clippy"');
  });

  it("does not duplicate checks already covered by test:all in the quality job", () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const qualityJob = workflow.match(
      /  quality-gate:[\s\S]*?(?=\n  [a-z][a-z-]+:)/,
    )?.[0];
    const smokeJob = workflow.match(
      /  smoke-build:[\s\S]*?(?=\n  [a-z][a-z-]+:)/,
    )?.[0];
    expect(qualityJob).toContain("npm run test:all");
    expect(qualityJob).not.toContain("cargo fmt --manifest-path");
    expect(smokeJob).toContain("npx tauri build --no-bundle");
    expect(smokeJob).not.toMatch(/- run: npm run build\s/);
  });

  it("routes prereleases to beta and stable releases to main", () => {
    expect(expectedReleaseBranch("0.6.0-beta.10")).toBe("beta");
    expect(expectedReleaseBranch("0.6.0-rc.2")).toBe("beta");
    expect(expectedReleaseBranch("0.6.0")).toBe("main");
  });
});
