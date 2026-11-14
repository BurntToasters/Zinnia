import assert from "node:assert/strict";
import { $, browser } from "@wdio/globals";
import { waitForMainWindow } from "../helpers/ui-driver.js";
import { writeEvidence } from "../helpers/recovery-harness.js";

const EVIDENCE_DIR = process.env.ZINNIA_E2E_EVIDENCE_DIR;

function invokeTauri(command) {
  return browser.executeAsync((name, done) => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke !== "function") {
      done({ error: "Tauri invoke is unavailable" });
      return;
    }
    invoke(name, {})
      .then((value) => done({ value }))
      .catch((error) =>
        done({ error: error instanceof Error ? error.message : String(error) }),
      );
  }, command);
}

describe("beta2 rust launch and exit", function () {
  this.timeout(120_000);

  before(async () => {
    await waitForMainWindow();
  });

  it("cold launch without argv carries no open request", async () => {
    const mode = await invokeTauri("get_initial_mode");
    assert.ok(!mode.error, `get_initial_mode failed: ${mode.error}`);
    assert.equal(
      mode.value,
      "",
      "a cold launch without argv must not inherit an open mode",
    );

    const handoffError = await invokeTauri("get_shell_handoff_error");
    assert.ok(
      !handoffError.error,
      `get_shell_handoff_error failed: ${handoffError.error}`,
    );
    assert.equal(
      handoffError.value,
      null,
      "a cold launch without argv must not report a shell handoff error",
    );

    const mainVisible = await $("#basic-workspace").isDisplayed();
    assert.equal(mainVisible, true, "the main workspace must be shown");

    writeEvidence(EVIDENCE_DIR, "beta2-rust-launch-exit-cold-idle", {
      scenario: "beta2-rust-launch-exit-cold-idle",
      launchArgv: [],
      initialMode: mode.value,
      shellHandoffError: handoffError.value,
      mainWorkspaceVisible: mainVisible,
    });
  });
});
