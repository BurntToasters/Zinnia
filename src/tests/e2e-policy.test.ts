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
    expect(cargo).toMatch(/\[features\]\s*default = \[\]/);
    const main = read("src-tauri/src/main.rs");
    expect(main).toContain('#[cfg(feature = "e2e")]');
    expect(main).toContain("tauri_plugin_wdio::init()");
    expect(main).toContain("tauri_plugin_wdio_webdriver::init()");
    const hook = read("src/e2e-hook.ts");
    expect(read("src/e2e-env.ts")).toContain(
      'import.meta.env.VITE_ZINNIA_E2E === "1"',
    );
    expect(hook).toContain("isE2eFrontend");
    expect(hook).toContain('import.meta.env.VITE_ZINNIA_E2E !== "1"');
    expect(read("src/e2e-wdio-plugin.ts")).toContain("isE2eFrontend");
    expect(read("src/e2e-wdio-plugin.ts")).toContain(
      'import.meta.env.VITE_ZINNIA_E2E !== "1"',
    );
    expect(read("src/setup-wizard.ts")).toContain("isE2eFrontend");
    expect(read("src/extract-destination.ts")).toContain("isE2eFrontend");
    expect(read("src/extract-destination.ts")).toContain("confirmChoice");
    expect(read("src/extract-destination.ts")).not.toContain(
      "@tauri-apps/plugin-dialog",
    );
    expect(read("src/ui/workspace.ts")).toContain("isE2eFrontend");
    expect(read("src/window-fx.ts")).toContain("isE2eFrontend");
    expect(read("src/app-init.ts")).toContain("isE2eFrontend");
    expect(read("e2e/helpers/profile.js")).toContain(
      "WEBVIEW2_USER_DATA_FOLDER",
    );
    expect(read("e2e/helpers/profile.js")).toContain(
      "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    );
    expect(read("scripts/test-e2e.js")).toContain("e2e-feature-8");
    expect(read("src-tauri/src/launch/mod.rs")).toContain(
      "fn e2e_session_active()",
    );
    expect(read("src-tauri/src/launch/mod.rs")).toContain("transparent(false)");
    expect(read("src-tauri/src/launch/mod.rs")).toContain(
      "additional_browser_args",
    );
    expect(read("src-tauri/src/launch/mod.rs")).toContain(
      "--disable-gpu --disable-features=CalculateNativeWinOcclusion,RendererCodeIntegrity",
    );
    expect(main).toContain('#[cfg(feature = "e2e")]');
    expect(main).toContain('#[cfg(not(feature = "e2e"))]');
    expect(main).toContain("production_integrations_enabled()");
    expect(main).toContain("launch::e2e_session_active()");
    expect(read("src-tauri/src/launch/mod.rs")).toContain(
      'std::env::var("ZINNIA_E2E").is_ok_and(|value| value == "1")',
    );
    expect(read("src-tauri/src/launch/mod.rs")).toContain(
      '#[cfg(not(feature = "e2e"))]',
    );
    expect(read("src-tauri/src/launch/mod.rs")).toMatch(
      /#\[cfg\(not\(feature = "e2e"\)\)\]\s*\{\s*false\s*\}/,
    );
    expect(read("scripts/test-e2e.js")).toContain("usesWindowsCmdShell");
    expect(read("scripts/test-e2e.js")).toContain("SKIP_E2E=1 is not allowed");
    expect(read("scripts/test-e2e.js")).toContain(
      'maxRetries: process.platform === "win32" ? 20 : 8',
    );
    expect(read("scripts/test-e2e.js")).toContain(
      "restoreGeneratedSchemas(schemaSnapshots)",
    );
    expect(read("scripts/test-e2e.js")).toContain("leaving it for OS cleanup");
    expect(read("scripts/test-e2e.js")).toMatch(
      /process\.execPath,\s*fileURLToPath\(import\.meta\.url\)/,
    );
    expect(read("scripts/test-e2e.js")).not.toMatch(
      /process\.execPath,\s*__filename/,
    );
    expect(read("scripts/test-all.js")).toContain(
      "SKIP_E2E=1 is not allowed for npm run test:all",
    );
    expect(read("scripts/test-all.js")).toContain("skipE2e");
    expect(read("scripts/run-release.js")).toContain("--skip-e2e");
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
      permissions: [
        "wdio-webdriver:default",
        "wdio:default",
        "process:allow-exit",
      ],
    });
    const wdioConfig = read("e2e/wdio.conf.js");
    expect(wdioConfig).toContain("after: requestGracefulAppShutdown");
    expect(wdioConfig).toContain('invoke("plugin:process|exit", { code: 0 })');
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
    expect(read(".github/workflows/ci.yml")).not.toMatch(
      /npm run test:all\s+--\s+--skip-e2e/,
    );
    expect(read(".github/workflows/ci.yml")).toContain("xvfb");
    expect(packageJson.scripts["setup:deb"]).toMatch(/\bxvfb\b/);
    expect(read("scripts/test-e2e.js")).toContain("sudo apt install -y xvfb");
    expect(read(".github/workflows/ci.yml")).toContain(
      "npm audit --omit=dev --audit-level=high",
    );
  });
});

describe("production archive IPC policy", () => {
  function productionTypeScriptFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "tests")
          files.push(...productionTypeScriptFiles(absolute));
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(absolute);
      }
    }
    return files;
  }

  it("centralizes bounded run_7z and probe envelopes in their IPC modules", () => {
    const backendPath = path.resolve(
      process.cwd(),
      "src/archive/backend-ipc.ts",
    );
    const probePath = path.resolve(
      process.cwd(),
      "src/archive/compress-probe-ipc.ts",
    );
    const backend = fs.readFileSync(backendPath, "utf8");
    expect(backend).not.toContain("import.meta.env.MODE");
    expect(backend).toContain('invoke<T>("run_7z", run7zInvokeArgs(request))');
    expect(backend).not.toMatch(
      /invoke(?:<[^>]+>)?\(\s*["']probe_compress_inputs["']/,
    );
    const probe = fs.readFileSync(probePath, "utf8");
    expect(probe).toMatch(
      /invoke<T>\(\s*"probe_compress_inputs",\s*compressInputProbeInvokeArgs\(paths\),?\s*\)/,
    );

    for (const file of productionTypeScriptFiles(
      path.resolve(process.cwd(), "src"),
    )) {
      if (file === backendPath || file === probePath) continue;
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).not.toMatch(
        /invoke(?:<[^>]+>)?\(\s*["'](?:run_7z|probe_compress_inputs)["']/,
      );
    }

    const commands = read("src-tauri/src/process/commands.rs");
    expect(commands).toMatch(
      /pub async fn run_7z\([\s\S]*?request_json: String,[\s\S]*?\) -> Result<RunResult, String>/,
    );
    expect(commands).toMatch(
      /pub async fn probe_compress_inputs\(\s*request_json: String,\s*\)/,
    );
  });
});
