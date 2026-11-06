import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readRepositoryFile(...segments: string[]): string {
  return fs.readFileSync(path.resolve(process.cwd(), ...segments), "utf8");
}

function readPinnedRustToolchain(): string {
  const channel = readRepositoryFile("rust-toolchain.toml").match(
    /^channel = "(\d+\.\d+\.\d+)"$/m,
  )?.[1];
  if (!channel) {
    throw new Error("rust-toolchain.toml must pin an exact Rust channel");
  }
  return channel;
}

function jobBodies(workflow: string): Array<{ name: string; body: string }> {
  const starts = [...workflow.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
  return starts.map((match, index) => ({
    name: match[1],
    body: workflow.slice(
      match.index,
      starts[index + 1]?.index ?? workflow.length,
    ),
  }));
}

function stepBodies(job: string): string[] {
  const lines = job.split(/\r?\n/);
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^ {6}- /.test(lines[index])) starts.push(index);
  }
  return starts.map((start, index) =>
    lines.slice(start, starts[index + 1] ?? lines.length).join("\n"),
  );
}

describe("Rust toolchain policy", () => {
  // Failure modes covered before implementation:
  // - the pin file is missing, floating, suffixed, or malformed/CRLF;
  // - the runtime CLI prints extra output or loses the extracted channel;
  // - package scripts keep a literal version or drop a target triple;
  // - a CI job extracts the pin before checkout or misses a toolchain consumer;
  // - extraction uses the wrong shell or writes malformed GITHUB_OUTPUT;
  // - Flatpak build-command shells lose the extracted pin and fall back to a literal;
  // - Windows spawn routes rustup through a shell.
  it("keeps the exact Rust channel in rust-toolchain.toml and prints it from one CLI", () => {
    const rustToolchain = readPinnedRustToolchain();
    expect(rustToolchain).toMatch(/^\d+\.\d+\.\d+$/);

    const cli = spawnSync(
      process.execPath,
      [path.resolve(process.cwd(), "scripts", "rust-toolchain.mjs")],
      { encoding: "utf8" },
    );
    expect(cli.status).toBe(0);
    expect(cli.stderr).toBe("");
    expect(cli.stdout.trim()).toBe(rustToolchain);
  });

  it("derives every Rust package script from the pin without dropping targets", () => {
    const rustToolchain = readPinnedRustToolchain();
    const packageText = readRepositoryFile("package.json");
    expect(packageText).not.toContain(rustToolchain);

    const packageJson = JSON.parse(packageText) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};
    const rustScripts = Object.entries(scripts).filter(([name]) =>
      name.startsWith("rust:"),
    );
    expect(rustScripts).toHaveLength(6);
    for (const [, command] of rustScripts) {
      expect(command).toMatch(/^node scripts\/rust-toolchain\.mjs /);
      expect(command).not.toContain("rustup");
    }

    expect(scripts["rust:update"]).toBe(
      "node scripts/rust-toolchain.mjs --install",
    );
    for (const [name, triples] of Object.entries({
      "rust:targets:win": "x86_64-pc-windows-msvc aarch64-pc-windows-msvc",
      "rust:targets:mac": "x86_64-apple-darwin aarch64-apple-darwin",
      "rust:targets:linux":
        "x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu",
      "rust:target:linux:x64": "x86_64-unknown-linux-gnu",
      "rust:target:linux:arm64": "aarch64-unknown-linux-gnu",
    })) {
      expect(scripts[name]).toBe(
        `node scripts/rust-toolchain.mjs --target ${triples}`,
      );
    }
  });

  it("extracts the pin after checkout in every CI job that installs Rust", () => {
    const rustToolchain = readPinnedRustToolchain();
    for (const [workflowPath, expectedConsumers] of [
      [".github/workflows/ci.yml", 6],
      [".github/workflows/archive-io-benchmark.yml", 1],
    ] as const) {
      const workflow = readRepositoryFile(workflowPath);
      expect(workflow).not.toContain("RUST_VERSION");
      expect(workflow).not.toContain(rustToolchain);

      const consumers = jobBodies(workflow).filter((job) =>
        job.body.includes("uses: dtolnay/rust-toolchain"),
      );
      expect(consumers).toHaveLength(expectedConsumers);
      for (const job of consumers) {
        const checkout = job.body.indexOf("uses: actions/checkout");
        const pin = job.body.indexOf("id: rust-pin");
        const toolchainUse = job.body.indexOf("uses: dtolnay/rust-toolchain");
        expect(checkout).toBeGreaterThanOrEqual(0);
        expect(pin).toBeGreaterThan(checkout);
        expect(toolchainUse).toBeGreaterThan(pin);
        expect(job.body).toContain(
          "toolchain: ${{ steps.rust-pin.outputs.version }}",
        );

        const pinStep = stepBodies(job.body).find((step) =>
          step.includes("id: rust-pin"),
        );
        expect(pinStep).toBeDefined();
        expect(pinStep).toContain("shell: bash");
        expect(pinStep).toContain("node scripts/rust-toolchain.mjs");
        expect(pinStep).toContain(
          'echo "version=$version" >> "$GITHUB_OUTPUT"',
        );
        expect(pinStep).not.toContain("pwsh");
      }
    }

    const rustCheck = jobBodies(
      readRepositoryFile(".github/workflows/ci.yml"),
    ).find((job) => job.name === "rust-check")?.body;
    expect(rustCheck).toBeDefined();
    expect(rustCheck).toMatch(/components:\s*clippy/);
  });

  it("derives the Flatpak compiler from the pin and documents the single source", () => {
    const rustToolchain = readPinnedRustToolchain();
    const flatpakManifest = readRepositoryFile("run.rosie.zinnia.yml");
    expect(flatpakManifest).not.toContain(rustToolchain);
    expect(flatpakManifest).toContain(
      "org.freedesktop.Sdk.Extension.rust-stable",
    );
    expect(flatpakManifest).toContain(
      "prepend-path: /run/build/zinnia/cargo/bin:/run/build/zinnia/npm-global/bin:/usr/lib/sdk/node24/bin:/usr/lib/sdk/rust-stable/bin",
    );
    expect(flatpakManifest).toContain("RUSTUP_HOME: /run/build/zinnia/rustup");
    expect(flatpakManifest).not.toContain("RUSTUP_TOOLCHAIN:");
    expect(flatpakManifest).toContain(
      "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs",
    );
    expect(flatpakManifest).toMatch(
      /- \|\n\s+set -eu\n\s+PINNED="\$\(sed [^\n]*rust-toolchain\.toml\)"\n\s+test -n "\$PINNED"\n\s+curl [^\n]*\n\s+test "\$\(rustc --version \| cut -d' ' -f2\)" = "\$PINNED"/,
    );
    expect(flatpakManifest.match(/--default-toolchain/g)).toHaveLength(1);

    const docs = readRepositoryFile("docs", "DEPENDENCY_UPDATES.md");
    expect(docs).not.toContain(rustToolchain);
    expect(docs).toMatch(/edit only `rust-toolchain\.toml`/i);
  });
});
