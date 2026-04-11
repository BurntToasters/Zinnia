import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCommandPreviewText,
  copyCommandPreview,
  previewCommand,
  sanitizeCommandArgsForPreview,
} from "../archive";
import { state } from "../state";

function setInputValue(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement;
  el.value = value;
}

describe("command preview", () => {
  beforeEach(() => {
    state.inputs = ["file.txt"];
    const app = document.getElementById("app") as HTMLElement;
    app.dataset.mode = "add";
    setInputValue("output-path", "archive.7z");
    setInputValue("password", "secret");
    setInputValue("extra-args", "");
    setInputValue("threads", "");
    const overlay = document.getElementById(
      "command-preview-overlay",
    ) as HTMLElement;
    overlay.hidden = true;
    const copyBtn = document.getElementById(
      "copy-command-preview",
    ) as HTMLButtonElement;
    copyBtn.textContent = "Copy";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("masks password arguments in command args preview", () => {
    expect(
      sanitizeCommandArgsForPreview(["a", "-psecret123", "archive.7z"]),
    ).toEqual(["a", "-p***", "archive.7z"]);
  });

  it("builds preview text with masked password args", () => {
    expect(buildCommandPreviewText(["a", "-psecret", "archive.7z"])).toBe(
      "7z a -p*** archive.7z",
    );
  });

  it("opens the command preview modal with preview text", async () => {
    await previewCommand();
    const overlay = document.getElementById(
      "command-preview-overlay",
    ) as HTMLElement;
    const preview = document.getElementById("command-preview-text");

    expect(overlay.hidden).toBe(false);
    expect(preview?.textContent).toContain("7z a");
    expect(preview?.textContent).toContain("-p***");
    expect(preview?.textContent).not.toContain("secret");
  });

  it("copies command preview text and resets copied state", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const preview = document.getElementById(
      "command-preview-text",
    ) as HTMLElement;
    preview.textContent = "7z a archive.7z file.txt";
    const copyBtn = document.getElementById(
      "copy-command-preview",
    ) as HTMLButtonElement;

    await copyCommandPreview();
    expect(writeText).toHaveBeenCalledWith("7z a archive.7z file.txt");
    expect(copyBtn.textContent).toBe("Copied");

    vi.advanceTimersByTime(1300);
    expect(copyBtn.textContent).toBe("Copy");
  });
});
