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
};
