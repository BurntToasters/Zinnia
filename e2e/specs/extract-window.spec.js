import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";

describe("Zinnia extract window", () => {
  it("extracts hello.7z launched with --extract", async () => {
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
    const dest = path.join(path.dirname(archive), "hello", "hello.txt");
    await browser.waitUntil(() => fs.existsSync(dest), {
      timeout: 10_000,
      timeoutMsg: `quick extract did not write ${dest}`,
    });
    assert.equal(fs.readFileSync(dest, "utf8"), payload);
  });
});
