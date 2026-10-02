import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";

const COUNTDOWN_LABEL = /^Close \((\d+)s\)$/;

async function closeLabel() {
  return (await $("#close-btn").getText()).trim();
}

async function dispatchPointerMoves(points) {
  await browser.execute((moves) => {
    for (const [screenX, screenY] of moves) {
      window.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, screenX, screenY }),
      );
    }
  }, points);
}

async function waitForLabel(predicate, description) {
  let last = "";
  await browser.waitUntil(
    async () => {
      last = await closeLabel();
      return predicate(last);
    },
    {
      timeout: 5_000,
      interval: 100,
      timeoutMsg: `close button never showed ${description}; last label: ${last}`,
    },
  );
  return last;
}

async function windowIsGone() {
  try {
    await browser.execute(() => document.readyState);
    return false;
  } catch {
    return true;
  }
}

describe("Zinnia extract window", () => {
  const observed = [];
  const record = async (step) => {
    observed.push({ step, label: await closeLabel() });
  };

  it("extracts hello.7z launched with --extract and starts the auto-close countdown", async () => {
    const archive = process.env.ZINNIA_E2E_HELLO_7Z;
    const payload = process.env.ZINNIA_E2E_PAYLOAD;
    await $("#extract-app").waitForExist({ timeout: 30_000 });
    const errorBox = await $("#extract-error");
    const closeBtn = await $("#close-btn");
    await closeBtn.waitForDisplayed({ timeout: 60_000 });
    if (await errorBox.isDisplayed()) {
      throw new Error(
        `extract window failed: ${await $("#error-detail").getText()}`,
      );
    }
    await waitForLabel((label) => COUNTDOWN_LABEL.test(label), "a countdown");
    await record("countdown-started");

    await dispatchPointerMoves([
      [200, 200],
      [200, 200],
      [201, 200],
      [200, 201],
      [200, 200],
    ]);
    await browser.pause(300);
    assert.match(
      await closeLabel(),
      COUNTDOWN_LABEL,
      "pointer events without real movement stopped the auto-close countdown",
    );
    await record("after-stationary-pointer-events");

    await dispatchPointerMoves([[260, 240]]);
    await waitForLabel((label) => label === "Close (paused)", "paused state");
    await record("after-real-pointer-move");

    assert.equal(
      await $("#extract-progress").getAttribute("data-saw-structured-percent"),
      "true",
      "quick extract never received a native 7-Zip percentage update",
    );
    const dest = path.join(path.dirname(archive), "hello", "hello.txt");
    await browser.waitUntil(() => fs.existsSync(dest), {
      timeout: 10_000,
      timeoutMsg: `quick extract did not write ${dest}`,
    });
    assert.equal(fs.readFileSync(dest, "utf8"), payload);

    await browser.pause(1_500);
    assert.equal(
      await closeLabel(),
      "Close (paused)",
      "paused countdown resumed while the pointer stayed in the window",
    );
    await record("paused-hold");
  });

  it("resumes when the pointer leaves and closes the window when the countdown ends", async () => {
    const seconds = Number(process.env.ZINNIA_E2E_AUTO_CLOSE_SECONDS);
    assert.ok(seconds > 0, "ZINNIA_E2E_AUTO_CLOSE_SECONDS must be positive");

    await browser.execute(() => {
      document.documentElement.dispatchEvent(
        new MouseEvent("mouseleave", { bubbles: false }),
      );
    });
    await waitForLabel((label) => COUNTDOWN_LABEL.test(label), "a countdown");
    await record("after-pointer-leave");

    await dispatchPointerMoves([
      [400, 400],
      [400, 400],
      [402, 401],
    ]);
    await browser.pause(300);
    assert.match(
      await closeLabel(),
      COUNTDOWN_LABEL,
      "re-entry pointer baseline paused the countdown without real movement",
    );
    await record("after-reentry-baseline");

    const resumedAt = Date.now();
    globalThis.__ZINNIA_E2E_APP_CLOSED_BY_SPEC__ = true;
    await browser.waitUntil(windowIsGone, {
      timeout: seconds * 1000 + 20_000,
      interval: 250,
      timeoutMsg: "extract window was still open after the countdown ended",
    });
    const closedAfterMs = Date.now() - resumedAt;
    observed.push({ step: "window-closed", closedAfterMs });
    console.log(
      `ZINNIA_E2E_AUTO_CLOSE_EVIDENCE ${JSON.stringify({ seconds, observed })}`,
    );
    assert.ok(
      closedAfterMs >= (seconds - 1) * 1000,
      `window closed after ${closedAfterMs}ms, before the ${seconds}s countdown`,
    );
  });
});
