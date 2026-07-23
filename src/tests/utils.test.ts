import { describe, it, expect } from "vitest";
import {
  $,
  escapeHtml,
  parseThreads,
  formatSize,
  splitArgs,
  redactSensitiveText,
  safeHref,
  isArchiveFile,
  assertRunResult,
  trapFocus,
  releaseFocusTrap,
} from "../utils";

function setVisibleForFocus(el: HTMLElement, parent: HTMLElement): void {
  Object.defineProperty(el, "offsetParent", {
    configurable: true,
    get: () => parent,
  });
}

describe("splitArgs", () => {
  it("splits quoted and unquoted arguments", () => {
    expect(splitArgs(`-mx=9 -w "C:/My Folder" 'file one.txt'`)).toEqual([
      "-mx=9",
      "-w",
      "C:/My Folder",
      "file one.txt",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(splitArgs("")).toEqual([]);
  });

  it("handles single argument", () => {
    expect(splitArgs("hello")).toEqual(["hello"]);
  });
});

describe("redactSensitiveText", () => {
  it("redacts -p password args", () => {
    expect(redactSensitiveText("run -pmySecret")).toContain("-p***");
  });

  it("redacts key=value passwords", () => {
    expect(redactSensitiveText("password=abc")).toContain("password=***");
  });

  it("redacts GitHub PATs", () => {
    expect(redactSensitiveText("ghp_1234567890123456789012345")).not.toContain(
      "ghp_",
    );
  });

  it("redacts Bearer tokens", () => {
    expect(redactSensitiveText("Authorization: Bearer abc.def.ghi")).toContain(
      "Bearer ***",
    );
  });

  it("redacts JWTs", () => {
    expect(
      redactSensitiveText(
        "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.sgntrData",
      ),
    ).not.toContain("eyJ");
  });

  it("redacts OpenAI-style keys", () => {
    expect(
      redactSensitiveText("OPENAI_KEY=sk-1234567890abcdefghijklmnopqr"),
    ).not.toContain("sk-123456");
  });
});

describe("isArchiveFile", () => {
  it("recognises known archive extensions", () => {
    expect(isArchiveFile("C:/tmp/file.7z")).toBe(true);
    expect(isArchiveFile("C:/tmp/file.tar.gz")).toBe(true);
    expect(isArchiveFile("/home/user/file.zip")).toBe(true);
    expect(isArchiveFile("file.rar")).toBe(true);
    expect(isArchiveFile("file.xz")).toBe(true);
    expect(isArchiveFile("file.bz2")).toBe(true);
  });

  it("rejects non-archive files", () => {
    expect(isArchiveFile("C:/tmp/file.txt")).toBe(false);
    expect(isArchiveFile("file.pdf")).toBe(false);
    expect(isArchiveFile("file")).toBe(false);
  });
});

describe("escapeHtml", () => {
  it("escapes special HTML characters", () => {
    expect(escapeHtml('<script>"test"</script>')).toBe(
      "&lt;script&gt;&quot;test&quot;&lt;/script&gt;",
    );
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("parseThreads", () => {
  it("parses valid thread counts", () => {
    expect(parseThreads("4", 2)).toBe(4);
  });

  it("returns fallback for NaN", () => {
    expect(parseThreads("abc", 2)).toBe(2);
    expect(parseThreads("", 2)).toBe(2);
    expect(parseThreads("abc", 0)).toBe(1);
    expect(parseThreads("abc", 999)).toBe(128);
  });

  it("clamps to minimum 1", () => {
    expect(parseThreads("0", 2)).toBe(1);
    expect(parseThreads("-5", 2)).toBe(1);
  });

  it("clamps to maximum 128", () => {
    expect(parseThreads("256", 2)).toBe(128);
    expect(parseThreads("999", 2)).toBe(128);
  });
});

describe("formatSize", () => {
  it("returns dash for zero bytes", () => {
    expect(formatSize(0)).toBe("-");
  });

  it("formats bytes", () => {
    expect(formatSize(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatSize(1048576)).toBe("1.0 MB");
  });

  it("formats gigabytes", () => {
    expect(formatSize(1073741824)).toBe("1.0 GB");
  });
});

describe("assertRunResult", () => {
  it("accepts a well-shaped run_7z payload", () => {
    expect(() =>
      assertRunResult({
        stdout: "",
        stderr: "",
        code: 0,
        stdout_truncated: false,
      }),
    ).not.toThrow();
  });

  it("rejects malformed payloads", () => {
    expect(() => assertRunResult(null)).toThrow(/Unexpected run_7z response/);
    expect(() => assertRunResult({ stdout: "", stderr: "" })).toThrow(
      /Unexpected run_7z response/,
    );
  });
});

describe("safeHref", () => {
  it("allows http/https URLs", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("http://example.com")).toBe("http://example.com");
    expect(safeHref("https://example.com?a=1&b=2")).toBe(
      "https://example.com?a=1&b=2",
    );
  });

  it("blocks non-http schemes", () => {
    expect(safeHref("javascript:alert(1)")).toBe("#");
    expect(safeHref("data:text/html,test")).toBe("#");
    expect(safeHref("file:///etc/passwd")).toBe("#");
    expect(safeHref("https://user:secret@example.com")).toBe("#");
    expect(safeHref("https://")).toBe("#");
    expect(safeHref("https://example.com\njavascript:alert(1)")).toBe("#");
  });

  it("blocks empty strings", () => {
    expect(safeHref("")).toBe("#");
  });
});

describe("$ helper", () => {
  it("returns element when it exists", () => {
    const el = document.createElement("div");
    el.id = "custom-test-id";
    document.body.appendChild(el);

    expect($("custom-test-id")).toBe(el);

    el.remove();
  });

  it("throws when element is missing", () => {
    expect(() => $("totally-missing-id")).toThrow(
      /Element #totally-missing-id not found/,
    );
  });
});

describe("focus trap helpers", () => {
  it("cycles focus on Tab and Shift+Tab", () => {
    const container = document.createElement("div");
    const first = document.createElement("button");
    const second = document.createElement("button");
    container.append(first, second);
    document.body.appendChild(container);

    setVisibleForFocus(first, container);
    setVisibleForFocus(second, container);

    trapFocus(container);
    expect(document.activeElement).toBe(first);

    second.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(first);

    first.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }),
    );
    expect(document.activeElement).toBe(second);

    releaseFocusTrap(container);
    container.remove();
  });

  it("supports re-trapping same container without throwing", () => {
    const container = document.createElement("div");
    const button = document.createElement("button");
    container.appendChild(button);
    document.body.appendChild(container);
    setVisibleForFocus(button, container);

    trapFocus(container);
    trapFocus(container);
    releaseFocusTrap(container);

    container.remove();
  });

  it("makes modal siblings inert and restores their prior state", () => {
    const background = document.createElement("main");
    const alreadyInert = document.createElement("aside");
    alreadyInert.inert = true;
    const overlay = document.createElement("div");
    const container = document.createElement("div");
    const button = document.createElement("button");
    container.appendChild(button);
    overlay.appendChild(container);
    document.body.append(background, alreadyInert, overlay);
    setVisibleForFocus(button, container);

    trapFocus(container);
    expect(background.inert).toBe(true);
    expect(alreadyInert.inert).toBe(true);

    releaseFocusTrap(container);
    expect(background.inert).toBe(false);
    expect(alreadyInert.inert).toBe(true);
    background.remove();
    alreadyInert.remove();
    overlay.remove();
  });

  it("makes titlebar and header inert while a modal is open", () => {
    const app = document.createElement("div");
    app.id = "app";
    const titlebar = document.createElement("div");
    titlebar.id = "titlebar";
    const closeBtn = document.createElement("button");
    closeBtn.id = "titlebar-close";
    titlebar.appendChild(closeBtn);
    const header = document.createElement("header");
    header.className = "header";
    const settingsBtn = document.createElement("button");
    settingsBtn.id = "open-settings";
    header.appendChild(settingsBtn);
    const overlay = document.createElement("div");
    overlay.id = "settings-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";
    const modalBtn = document.createElement("button");
    modal.appendChild(modalBtn);
    overlay.appendChild(modal);
    const main = document.createElement("main");
    app.append(titlebar, header, overlay, main);
    document.body.appendChild(app);
    setVisibleForFocus(modalBtn, modal);

    trapFocus(modal);
    expect(Boolean(titlebar.inert)).toBe(true);
    expect(Boolean(header.inert)).toBe(true);
    expect(main.inert).toBe(true);
    expect(closeBtn.disabled).toBe(false);
    expect(settingsBtn.disabled).toBe(false);

    releaseFocusTrap(modal);
    expect(main.inert).toBe(false);
    app.remove();
  });

  it("returns escaped focus to the modal on Tab", () => {
    const outside = document.createElement("button");
    const modal = document.createElement("div");
    const first = document.createElement("button");
    const last = document.createElement("button");
    modal.append(first, last);
    document.body.append(outside, modal);
    setVisibleForFocus(first, modal);
    setVisibleForFocus(last, modal);
    trapFocus(modal);
    outside.focus();

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    expect(document.activeElement).toBe(first);

    outside.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(document.activeElement).toBe(last);
    releaseFocusTrap(modal);
    outside.remove();
    modal.remove();
  });
});
