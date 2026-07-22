import { beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-shell";
import { openExternalUrl, wireExternalLinkClicks } from "../external-links";

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
    document.body.innerHTML = "";
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

  it("intercepts anchor clicks for http(s) links", async () => {
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "https://rosie.run/support");
    anchor.textContent = "Support";
    document.body.appendChild(anchor);
    wireExternalLinkClicks();

    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => {
      expect(openMock).toHaveBeenCalledWith("https://rosie.run/support");
    });
  });
});
