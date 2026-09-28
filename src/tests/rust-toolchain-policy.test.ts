import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readRepositoryFile(...segments: string[]): string {
  return fs.readFileSync(path.resolve(process.cwd(), ...segments), "utf8");
}

describe("Rust toolchain policy", () => {
  // Failure modes covered: a build script installs a different compiler than
  // Cargo selects; target setup adds targets to a moving channel; CI silently
  // follows a newer compiler; or Flatpak releases compile with a different
  // Rust toolchain than native releases.
  it("pins every release/build path to the same exact Rust toolchain", () => {
    const rustToolchain = "1.98.1";
    expect(readRepositoryFile("rust-toolchain.toml")).toMatch(
      new RegExp(`^channel = "${rustToolchain}"$`, "m"),
    );

    const packageJson = JSON.parse(readRepositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const rustScripts = Object.entries(packageJson.scripts ?? {}).filter(
      ([name]) => name.startsWith("rust:"),
    );
    expect(rustScripts.length).toBeGreaterThan(0);
    for (const [, command] of rustScripts) {
      expect(command).toContain(rustToolchain);
    }
    expect(packageJson.scripts?.["rust:update"]).toContain(
      `toolchain install ${rustToolchain}`,
    );

    const workflow = readRepositoryFile(".github", "workflows", "ci.yml");
    expect(workflow).toContain(`RUST_VERSION: "${rustToolchain}"`);
    const workflowToolchains = workflow.match(/^\s+toolchain: .+$/gm) ?? [];
    expect(workflowToolchains.length).toBeGreaterThan(0);
    expect(
      workflowToolchains.every((line) =>
        line.endsWith("${{ env.RUST_VERSION }}"),
      ),
    ).toBe(true);
    expect(workflow).toMatch(
      /rust-check:[\s\S]*cargo clippy --locked --manifest-path src-tauri\/Cargo\.toml --all-targets -- -D warnings/,
    );
    const rustCheckStart = workflow.indexOf("\n  rust-check:");
    const rustCheckEnd = workflow.indexOf(
      "\n  updater-manifest:",
      rustCheckStart,
    );
    expect(rustCheckStart).toBeGreaterThanOrEqual(0);
    expect(rustCheckEnd).toBeGreaterThan(rustCheckStart);
    const rustCheckJob = workflow.slice(rustCheckStart, rustCheckEnd);
    expect(rustCheckJob).toContain("toolchain: ${{ env.RUST_VERSION }}");
    expect(rustCheckJob).toMatch(/^\s+components: clippy\s*$/m);
    const benchmarkWorkflow = readRepositoryFile(
      ".github",
      "workflows",
      "archive-io-benchmark.yml",
    );
    expect(benchmarkWorkflow).toContain(`RUST_VERSION: "${rustToolchain}"`);

    const flatpakManifest = readRepositoryFile("run.rosie.zinnia.yml");
    expect(flatpakManifest).toContain(
      "org.freedesktop.Sdk.Extension.rust-stable",
    );
    expect(flatpakManifest).not.toContain("RUSTUP_TOOLCHAIN:");
    expect(flatpakManifest).not.toContain("rustup toolchain install");
    expect(flatpakManifest).toContain(
      `test "$(rustc --version | cut -d' ' -f2)" = ${rustToolchain}`,
    );
  });
});
