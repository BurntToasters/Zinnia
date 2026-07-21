import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readRepositoryFile(...segments: string[]): string {
  return fs.readFileSync(path.resolve(process.cwd(), ...segments), "utf8");
}

describe("Rust toolchain policy", () => {
  it("uses the latest stable channel across local, CI, release, and Flatpak builds", () => {
    expect(readRepositoryFile("rust-toolchain.toml")).toMatch(
      /^channel = "stable"$/m,
    );

    const packageJson = JSON.parse(readRepositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const rustScripts = Object.entries(packageJson.scripts ?? {}).filter(
      ([name]) => name.startsWith("rust:"),
    );
    expect(rustScripts.length).toBeGreaterThan(0);
    for (const [, command] of rustScripts) {
      expect(command).toMatch(/(?:install stable|--toolchain stable)/);
    }

    const workflow = readRepositoryFile(".github", "workflows", "ci.yml");
    const workflowToolchains = workflow.match(/^\s+toolchain: .+$/gm) ?? [];
    expect(workflowToolchains.length).toBeGreaterThan(0);
    expect(workflowToolchains.every((line) => line.endsWith("stable"))).toBe(
      true,
    );
    expect(workflow).toMatch(
      /rust-check:[\s\S]*cargo clippy --manifest-path src-tauri\/Cargo\.toml --all-targets -- -D warnings/,
    );

    expect(readRepositoryFile("run.rosie.zinnia.yml")).toMatch(
      /^\s+RUSTUP_TOOLCHAIN: stable$/m,
    );
  });
});
