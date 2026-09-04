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
    expect(packageJson.scripts["prerelease:prepare"]).toContain(
      "release:licenses",
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
    // Update entry points only mutate lockfiles; dependency code runs later.
    expect(packageJson.scripts.u2).toBe(packageJson.scripts.u);
    for (const command of [packageJson.scripts.u, packageJson.scripts.u2]) {
      expect(command).toContain("node scripts/npm-safe-update.mjs");
      expect(command).toContain("node scripts/cargo-safe-update.mjs");
      expect(command).not.toContain("workspace:");
      expect(command).not.toContain("test:all");
      expect(command).not.toContain("validate:updater");
    }

    const releaseRunner = fs.readFileSync(
      path.join(root, "scripts", "run-release.js"),
      "utf8",
    );
    expect(releaseRunner).toContain("prerelease:prepare");
    expect(releaseRunner).toContain("workspace:bootstrap");
    expect(releaseRunner).toContain("test:all");
    expect(releaseRunner).toContain("--require-clean-proof");
    expect(releaseRunner).toContain("--skip-e2e");
    expect(releaseRunner).toContain("dist:clean-release-artifacts");
    for (const platform of ["win", "mac"] as const) {
      const full = packageJson.scripts[`release:${platform}`];
      const resume = packageJson.scripts[`release:${platform}:resume`];
      const continuation = packageJson.scripts[`release:${platform}:continue`];
      expect(full).toBe(`node scripts/run-release.js ${platform}`);
      expect(resume).toContain("prerelease:prepare");
      expect(resume).not.toContain("npm run release:prepare");
      expect(continuation).toContain("release:session:verify");
      expect(continuation).toContain("npm run release:licenses");
      expect(continuation).toContain(":prepared");
    }
    for (const architecture of ["x64", "arm64"] as const) {
      const full = packageJson.scripts[`release:linux:${architecture}`];
      const resume =
        packageJson.scripts[`release:linux:${architecture}:resume`];
      const continuation =
        packageJson.scripts[`release:linux:${architecture}:continue`];
      expect(full).toBe(`node scripts/run-release.js linux:${architecture}`);
      expect(resume).not.toContain("npm run release:prepare");
      expect(continuation).toContain("release:session:verify");
      expect(continuation).toContain("npm run release:licenses");
      expect(continuation).toContain(":prepared");
    }

    expect(packageJson.scripts["build:win"]).toContain("build:win:prepared");
    expect(packageJson.scripts["build:win"].match(/licenses/g)).toHaveLength(1);
    // Branch/clean-tree gates stay on publish entry points only, not u/u2.
    expect(packageJson.scripts.u).not.toContain("workspace:bootstrap");
    expect(packageJson.scripts.u).not.toContain("release:prepare");
    expect(packageJson.scripts.u2).not.toContain("workspace:bootstrap");
    expect(packageJson.scripts.u2).not.toContain("release:prepare");
    expect(packageJson.scripts.u).not.toContain("release:preflight");
    expect(packageJson.scripts.u2).not.toContain("release:preflight");
    expect(packageJson.scripts["release:win"]).toBe(
      "node scripts/run-release.js win",
    );
    expect(packageJson.scripts["release:linux"]).toBe(
      "node scripts/run-release.js linux",
    );
    expect(packageJson.scripts["release:session:verify"]).toContain(
      "release-session.js",
    );
    expect(testRunner).toContain('"rustfmt"');
    expect(testRunner).toContain('"rustprep"');
    expect(testRunner).toContain('"prepare:rust-tests"');
    expect(testRunner).toContain('"clippy"');
    expect(packageJson.scripts["prepare:rust-tests"]).toContain(
      "ensure-windows-context-menu-stubs.mjs",
    );
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

  it("routes betas to beta, stable releases to main, and rejects other stages", () => {
    expect(expectedReleaseBranch("0.6.0-beta.10")).toBe("beta");
    expect(expectedReleaseBranch("0.6.0")).toBe("main");
    expect(() => expectedReleaseBranch("0.6.0-alpha.2")).toThrow(
      /beta or stable only/,
    );
    expect(() => expectedReleaseBranch("0.6.0-rc.2")).toThrow(
      /beta or stable only/,
    );
    expect(() => expectedReleaseBranch("0.6.0-beta.02")).toThrow(
      /beta or stable only/,
    );
  });
});
