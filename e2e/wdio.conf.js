const binary = process.env.ZINNIA_E2E_BINARY;
if (!binary) {
  throw new Error("ZINNIA_E2E_BINARY is not set (run npm run test:e2e)");
}

const specs = process.env.ZINNIA_E2E_SPECS
  ? [process.env.ZINNIA_E2E_SPECS]
  : ["./specs/**/*.spec.js"];

let appArgs = [];
if (process.env.ZINNIA_E2E_APP_ARGS) {
  appArgs = JSON.parse(process.env.ZINNIA_E2E_APP_ARGS);
}

async function requestGracefulAppShutdown() {
  const activeBrowser = globalThis.browser;
  if (!activeBrowser?.sessionId) return;

  const processApiAvailable = await activeBrowser.execute(
    () => typeof window.__TAURI__?.core?.invoke === "function",
  );
  if (!processApiAvailable) {
    throw new Error("Tauri process API is unavailable during E2E teardown");
  }

  // WDIO's embedded provider terminates only the top-level app process. On
  // Windows that can orphan WebView2 children long enough to lock the isolated
  // profile. Ask Tauri to exit first, after this WebDriver command responds.
  await activeBrowser.execute(() => {
    window.setTimeout(() => {
      void window.__TAURI__.core
        .invoke("plugin:process|exit", { code: 0 })
        .catch(() => {});
    }, 50);
  });
}

export const config = {
  runner: "local",
  specs,
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "wdio:maxInstances": 1,
      "tauri:options": {
        application: binary,
        args: appArgs,
      },
    },
  ],
  logLevel: "warn",
  bail: 1,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 2,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: binary,
        appArgs,
        driverProvider: "embedded",
        windowLabel: process.env.ZINNIA_E2E_WINDOW_LABEL || "main",
        startTimeout: 180_000,
      },
    ],
  ],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },
  after: requestGracefulAppShutdown,
};
