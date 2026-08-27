import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
}

describe("unpackaged E2E must not ship in release builds", () => {
  it("keeps the WebDriver plugin behind Cargo feature e2e", () => {
    const cargo = read("src-tauri/Cargo.toml");
    expect(cargo).toMatch(
      /tauri-plugin-wdio = \{ version = "1", optional = true \}/,
    );
    expect(cargo).toMatch(
      /tauri-plugin-wdio-webdriver = \{ version = "1", optional = true \}/,
    );
    expect(cargo).toMatch(
      /e2e = \["dep:tauri-plugin-wdio", "dep:tauri-plugin-wdio-webdriver"\]/,
    );
    const main = read("src-tauri/src/main.rs");
    expect(main).toContain('#[cfg(feature = "e2e")]');
    expect(main).toContain("tauri_plugin_wdio::init()");
    expect(main).toContain("tauri_plugin_wdio_webdriver::init()");
    const hook = read("src/e2e-hook.ts");
    expect(hook).toContain('import.meta.env.VITE_ZINNIA_E2E !== "1"');
    expect(read("src/e2e-wdio-plugin.ts")).toContain(
      'await import("@wdio/tauri-plugin")',
    );
  });

  it("keeps the WebDriver capability out of production and limited to e2e windows", () => {
    const overlay = JSON.parse(read("src-tauri/tauri.e2e.conf.json")) as {
      app: {
        security: {
          capabilities: Array<
            | string
            | { identifier: string; windows: string[]; permissions: string[] }
          >;
        };
      };
    };
    const capability = overlay.app.security.capabilities.find(
      (entry) => typeof entry !== "string" && entry.identifier === "e2e",
    );
    expect(capability).toEqual({
      identifier: "e2e",
      description:
        "WebDriver ACL for unpackaged E2E builds. Production tauri.conf.json does not enable this capability.",
      windows: ["main", "extract-*", "debug-console"],
      permissions: ["wdio-webdriver:default", "wdio:default"],
    });
    expect(
      fs.existsSync(
        path.resolve(process.cwd(), "src-tauri", "capabilities", "e2e.json"),
      ),
    ).toBe(false);
  });

  it("does not enable the e2e capability in production tauri.conf.json", () => {
    const production = JSON.parse(read("src-tauri/tauri.conf.json")) as {
      app: { security: { capabilities: string[] } };
    };
    expect(production.app.security.capabilities).toEqual([
      "default",
      "extract-window",
      "debug-console-window",
    ]);
    expect(production.app.security.capabilities).not.toContain("e2e");
    expect(
      (production.app as { withGlobalTauri?: boolean }).withGlobalTauri ??
        false,
    ).toBe(false);
    const overlay = JSON.parse(read("src-tauri/tauri.e2e.conf.json")) as {
      build?: { beforeBuildCommand?: string };
      app?: { withGlobalTauri?: boolean };
    };
    expect(overlay.build?.beforeBuildCommand).toBe("npx vite build --mode e2e");
    expect(overlay.app?.withGlobalTauri).toBe(true);
  });

  it("keeps release and smoke build commands free of --features e2e", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.scripts["test:e2e"]).toBe("node scripts/test-e2e.js");
    expect(packageJson.devDependencies?.["@wdio/tauri-plugin"]).toBeDefined();
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (name === "test:e2e") continue;
      expect(command, name).not.toMatch(/--features\s+e2e/);
    }
    expect(read("scripts/tauri-windows-build.js")).not.toMatch(
      /--features\s+e2e/,
    );
    expect(read(".github/workflows/ci.yml")).toContain(
      "npx tauri build --no-bundle",
    );
    expect(read(".github/workflows/ci.yml")).not.toMatch(
      /tauri build --no-bundle[^\n]*e2e/,
    );
    expect(read(".github/workflows/ci.yml")).toContain("npm run test:e2e");
    expect(read(".github/workflows/ci.yml")).toContain("xvfb");
  });
});
