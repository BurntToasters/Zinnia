import { beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-shell";
import fs from "node:fs";
import path from "node:path";
import { openExternalUrl } from "../external-links";

const openMock = vi.mocked(open);
const logMock = vi.fn();

vi.mock("../ui", () => ({
  log: (...args: unknown[]) => logMock(...args),
}));

describe("external links", () => {
  beforeEach(() => {
    openMock.mockReset();
    openMock.mockResolvedValue(undefined);
    logMock.mockReset();
  });

  it("opens safe http(s) URLs via the shell plugin", async () => {
    await openExternalUrl("https://rosie.run/support");
    expect(openMock).toHaveBeenCalledWith("https://rosie.run/support");
  });

  it("blocks unsafe URLs", async () => {
    await openExternalUrl("javascript:alert(1)");
    expect(openMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(
      expect.stringContaining("Blocked unsafe external URL"),
      "error",
    );
  });

  it("does not add a second click interceptor on top of shell target=_blank", () => {
    // Regression: capture-phase open() + shell plugin IIFF opened two tabs.
    const appInit = fs.readFileSync(
      path.resolve(process.cwd(), "src", "app-init.ts"),
      "utf8",
    );
    expect(appInit).not.toMatch(/wireExternalLinkClicks/);
    expect(appInit).toMatch(
      /openExternalUrl\("https:\/\/rosie\.run\/support"\)/,
    );
  });
});
