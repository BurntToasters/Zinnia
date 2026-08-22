import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readRepositoryFile(...segments: string[]): string {
  return fs.readFileSync(path.resolve(process.cwd(), ...segments), "utf8");
}

describe("Rust toolchain policy", () => {
  it("pins rustup and CI while using the Flatpak stable extension", () => {
    const pinnedVersion = "1.97.1";
    expect(readRepositoryFile("rust-toolchain.toml")).toMatch(
      new RegExp(`^channel = "${pinnedVersion.replaceAll(".", "\\.")}"$`, "m"),
    );

    const packageJson = JSON.parse(readRepositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const rustScripts = Object.entries(packageJson.scripts ?? {}).filter(
      ([name]) => name.startsWith("rust:"),
    );
    expect(rustScripts.length).toBeGreaterThan(0);
    for (const [, command] of rustScripts) {
      expect(command).toContain(pinnedVersion);
    }

    const workflow = readRepositoryFile(".github", "workflows", "ci.yml");
    expect(workflow).toContain(`RUST_VERSION: "${pinnedVersion}"`);
    const workflowToolchains = workflow.match(/^\s+toolchain: .+$/gm) ?? [];
    expect(workflowToolchains.length).toBeGreaterThan(0);
    expect(
      workflowToolchains.every((line) =>
        line.endsWith("${{ env.RUST_VERSION }}"),
      ),
    ).toBe(true);
    expect(workflow).toMatch(
      /rust-check:[\s\S]*cargo clippy --manifest-path src-tauri\/Cargo\.toml --all-targets -- -D warnings/,
    );

    const flatpakManifest = readRepositoryFile("run.rosie.zinnia.yml");
    expect(flatpakManifest).toContain(
      "org.freedesktop.Sdk.Extension.rust-stable",
    );
    expect(flatpakManifest).toMatch(/^\s+RUSTUP_TOOLCHAIN: stable$/m);
  });
});
