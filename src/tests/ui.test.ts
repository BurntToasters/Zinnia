import { describe, it, expect, beforeEach } from "vitest";
import {
  buildLogFragments,
  shouldPersistLevel,
  truncateValidationReason,
  mapArchiveValidationResult,
  getMode,
  setMode,
  setActivityPanelVisible,
  setBrowsePasswordFieldVisible,
  setStatus,
  setProgress,
  hideProgress,
  log,
  renderInputs,
  setRunning,
  toggleActivity,
} from "../ui";
import { state, dom } from "../state";
import { SETTING_DEFAULTS } from "../settings-model";

beforeEach(() => {
  state.inputs = [];
  state.running = false;
  state.lastAutoExtractDestination = null;
  state.lastInputsSignature = "";
  state.browseArchiveInfoByPath.clear();
  state.browseSelectionsByArchive.clear();
  state.selectiveSearchQuery = "";
  state.selectiveActiveArchive = null;
  state.selectiveVisiblePaths = [];
  state.statusTimeout = undefined;
  state.currentSettings = { ...SETTING_DEFAULTS };
  state.inputValidationByPath.clear();
  state.inputValidationRequestId = 0;
  state.lastInputValidationMode = "add";

  dom.appEl.dataset.mode = "add";
  dom.logEl.textContent = "";
  dom.statusEl.textContent = "";
  dom.progressEl.textContent = "";
  dom.progressEl.hidden = true;
  dom.inputList.innerHTML = "";
  dom.runBtn.disabled = false;
  dom.runBtn.removeAttribute("aria-busy");
  dom.cancelBtn.hidden = true;
  dom.extractRunBtn.disabled = false;
  dom.extractRunBtn.removeAttribute("aria-busy");
  dom.extractCancelBtn.hidden = true;
  dom.gridEl.classList.remove("show-activity");
});

describe("validation helpers", () => {
  it("truncates long validation reason with ellipsis", () => {
    const result = truncateValidationReason("x".repeat(100), 10);
    expect(result).toBe("xxxxxxxxx…");
  });

  it("uses fallback text for empty validation reason", () => {
    expect(truncateValidationReason("")).toBe("Unsupported archive file.");
  });

  it("maps valid archive result", () => {
    expect(
      mapArchiveValidationResult({ path: "/tmp/a.7z", valid: true }),
    ).toEqual({ state: "valid" });
  });

  it("maps invalid archive result with reason and short reason", () => {
    const mapped = mapArchiveValidationResult({
      path: "/tmp/a.txt",
      valid: false,
      reason: "Not a supported archive",
    });
    expect(mapped.state).toBe("invalid");
    expect(mapped.reason).toBe("Not a supported archive");
    expect(mapped.reasonShort).toBe("Not a supported archive");
  });
});

describe("buildLogFragments", () => {
  it("returns single fragment for short input", () => {
    const result = buildLogFragments("hello world");
    expect(result).toEqual(["hello world"]);
  });

  it("returns single fragment at MAX_LOG_ENTRY_CHARS boundary", () => {
    const text = "a".repeat(8000);
    const result = buildLogFragments(text);
    expect(result).toEqual([text]);
  });

  it("splits long input into chunks with truncation notice", () => {
    const text = "a".repeat(10000);
    const result = buildLogFragments(text);
    expect(result.length).toBeGreaterThan(1);
    expect(result[result.length - 1]).toContain("[truncated");
    expect(result[result.length - 1]).toContain("2000 chars");
  });

  it("caps at MAX_LOG_ENTRY_CHARS before chunking", () => {
    const text = "x".repeat(20000);
    const result = buildLogFragments(text);
    const totalContent = result.slice(0, -1).join("");
    expect(totalContent.length).toBe(8000);
  });

  it("handles empty string", () => {
    expect(buildLogFragments("")).toEqual([""]);
  });
});

describe("shouldPersistLevel", () => {
  it("always persists info level", () => {
    expect(shouldPersistLevel("info", "info")).toBe(true);
    expect(shouldPersistLevel("info", "debug")).toBe(true);
  });

  it("always persists error level", () => {
    expect(shouldPersistLevel("error", "info")).toBe(true);
    expect(shouldPersistLevel("error", "debug")).toBe(true);
  });

  it("only persists debug when verbosity is debug", () => {
    expect(shouldPersistLevel("debug", "debug")).toBe(true);
    expect(shouldPersistLevel("debug", "info")).toBe(false);
  });
});

describe("getMode", () => {
  it('returns "add" by default', () => {
    dom.appEl.dataset.mode = "";
    expect(getMode()).toBe("add");
  });

  it('returns "extract"', () => {
    dom.appEl.dataset.mode = "extract";
    expect(getMode()).toBe("extract");
  });

  it('returns "browse"', () => {
    dom.appEl.dataset.mode = "browse";
    expect(getMode()).toBe("browse");
  });

  it('returns "add" for unknown mode', () => {
    dom.appEl.dataset.mode = "unknown";
    expect(getMode()).toBe("add");
  });
});

describe("setMode", () => {
  it("sets mode on app element", () => {
    setMode("extract");
    expect(dom.appEl.dataset.mode).toBe("extract");
  });

  it("activates correct mode button", () => {
    setMode("browse");
    const modeButtons = document.querySelectorAll("[data-mode-btn]");
    modeButtons.forEach((btn) => {
      const el = btn as HTMLButtonElement;
      if (el.dataset.modeBtn === "browse") {
        expect(el.classList.contains("is-active")).toBe(true);
      } else {
        expect(el.classList.contains("is-active")).toBe(false);
      }
    });
  });

  it("clears browse session state when changing modes", () => {
    state.selectiveSearchQuery = "test";
    state.selectiveActiveArchive = "archive.7z";
    setMode("extract");
    expect(state.selectiveSearchQuery).toBe("");
    expect(state.selectiveActiveArchive).toBeNull();
  });

  it("does not clear browse state when staying in same mode", () => {
    dom.appEl.dataset.mode = "extract";
    state.selectiveSearchQuery = "keep";
    setMode("extract");
    expect(state.selectiveSearchQuery).toBe("keep");
  });

  it("persists current working mode in state settings", () => {
    setMode("browse", { persist: false });
    expect(state.currentSettings.lastMode).toBe("browse");
  });
});

describe("setBrowsePasswordFieldVisible", () => {
  it("shows the browse password field", () => {
    const field = document.getElementById("browse-password-field")!;
    field.hidden = true;
    setBrowsePasswordFieldVisible(true);
    expect(field.hidden).toBe(false);
  });

  it("hides and resets the browse password field", () => {
    const field = document.getElementById("browse-password-field")!;
    const input = document.getElementById(
      "browse-password",
    ) as HTMLInputElement;
    const toggle = document.getElementById(
      "toggle-browse-password",
    ) as HTMLButtonElement;
    field.hidden = false;
    input.value = "secret";
    input.type = "text";
    toggle.textContent = "Hide";

    setBrowsePasswordFieldVisible(false);

    expect(field.hidden).toBe(true);
    expect(input.value).toBe("");
    expect(input.type).toBe("password");
    expect(toggle.textContent).toBe("Show");
  });
});

describe("setStatus", () => {
  it("sets status text", () => {
    setStatus("Compressing...");
    expect(dom.statusEl.textContent).toBe("Compressing...");
  });

  it("overrides previous status", () => {
    setStatus("First");
    setStatus("Second");
    expect(dom.statusEl.textContent).toBe("Second");
  });
});

describe("setProgress / hideProgress", () => {
  it("shows and sets progress text", () => {
    setProgress("50%");
    expect(dom.progressEl.textContent).toBe("50%");
    expect(dom.progressEl.hidden).toBe(false);
  });

  it("hides progress", () => {
    setProgress("50%");
    hideProgress();
    expect(dom.progressEl.hidden).toBe(true);
  });
});

describe("toggleActivity", () => {
  it("toggles show-activity class on grid", () => {
    expect(dom.gridEl.classList.contains("show-activity")).toBe(false);
    toggleActivity();
    expect(dom.gridEl.classList.contains("show-activity")).toBe(true);
    toggleActivity();
    expect(dom.gridEl.classList.contains("show-activity")).toBe(false);
  });
});

describe("setActivityPanelVisible", () => {
  it("applies visibility and updates setting value", () => {
    setActivityPanelVisible(true, { persist: false });
    expect(dom.gridEl.classList.contains("show-activity")).toBe(true);
    expect(state.currentSettings.showActivityPanel).toBe(true);

    setActivityPanelVisible(false, { persist: false });
    expect(dom.gridEl.classList.contains("show-activity")).toBe(false);
    expect(state.currentSettings.showActivityPanel).toBe(false);
  });
});

describe("log", () => {
  it("appends timestamped line to log element", () => {
    log("Test message");
    expect(dom.logEl.textContent).toContain("Test message");
    expect(dom.logEl.textContent).toMatch(/\[\d+:\d+:\d+/);
  });

  it("appends multiple log lines", () => {
    log("First");
    log("Second");
    expect(dom.logEl.textContent).toContain("First");
    expect(dom.logEl.textContent).toContain("Second");
  });
});

describe("renderInputs", () => {
  it("shows empty state message in add mode", () => {
    state.inputs = [];
    renderInputs();
    expect(dom.inputList.textContent).toContain(
      "Drop files here or use the buttons above.",
    );
  });

  it("shows extract empty state message in extract mode", () => {
    dom.appEl.dataset.mode = "extract";
    state.inputs = [];
    renderInputs();
    expect(dom.inputList.textContent).toContain(
      "Select an archive file to extract.",
    );
  });

  it("shows browse empty state message in browse mode", () => {
    dom.appEl.dataset.mode = "browse";
    state.inputs = [];
    renderInputs();
    expect(dom.inputList.textContent).toContain(
      "Select an archive to preview its contents.",
    );
  });

  it("renders input items with paths", () => {
    state.inputs = ["file1.txt", "file2.txt"];
    renderInputs();
    const items = dom.inputList.querySelectorAll(".list__item");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain("file1.txt");
    expect(items[1].textContent).toContain("file2.txt");
  });

  it("renders remove buttons for each item", () => {
    state.inputs = ["a.txt", "b.txt"];
    renderInputs();
    const buttons = dom.inputList.querySelectorAll("button");
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toBe("Remove");
  });

  it("disables remove buttons when running", () => {
    state.inputs = ["a.txt"];
    state.running = true;
    renderInputs();
    const btn = dom.inputList.querySelector("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("clears browse session state when input signature changes", () => {
    state.inputs = ["old.7z"];
    state.lastInputsSignature = "old.7z";
    state.selectiveSearchQuery = "something";
    renderInputs();
    state.inputs = ["new.7z"];
    renderInputs();
    expect(state.selectiveSearchQuery).toBe("");
  });
});

describe("setRunning", () => {
  it("disables run button and shows cancel in add mode", () => {
    dom.appEl.dataset.mode = "add";
    setRunning(true);
    expect(dom.runBtn.disabled).toBe(true);
    expect(dom.runBtn.getAttribute("aria-busy")).toBe("true");
    expect(dom.cancelBtn.hidden).toBe(false);
  });

  it("re-enables run button and hides cancel when stopped in add mode", () => {
    dom.appEl.dataset.mode = "add";
    setRunning(true);
    setRunning(false);
    expect(dom.runBtn.disabled).toBe(false);
    expect(dom.runBtn.hasAttribute("aria-busy")).toBe(false);
    expect(dom.cancelBtn.hidden).toBe(true);
  });

  it("disables extract button in extract mode", () => {
    dom.appEl.dataset.mode = "extract";
    setRunning(true);
    expect(dom.extractRunBtn.disabled).toBe(true);
    expect(dom.extractRunBtn.getAttribute("aria-busy")).toBe("true");
    expect(dom.extractCancelBtn.hidden).toBe(false);
  });

  it("disables browse buttons in browse mode", () => {
    dom.appEl.dataset.mode = "browse";
    setRunning(true);
    for (const id of [
      "browse-list",
      "browse-test",
      "browse-extract",
      "browse-selective",
    ]) {
      const el = document.getElementById(id) as HTMLButtonElement;
      expect(el.disabled).toBe(true);
    }
  });

  it("disables mode buttons when running", () => {
    setRunning(true);
    document
      .querySelectorAll<HTMLButtonElement>("[data-mode-btn]")
      .forEach((btn) => {
        expect(btn.disabled).toBe(true);
      });
  });

  it("re-enables mode buttons when stopped", () => {
    setRunning(true);
    setRunning(false);
    document
      .querySelectorAll<HTMLButtonElement>("[data-mode-btn]")
      .forEach((btn) => {
        expect(btn.disabled).toBe(false);
      });
  });

  it("disables utility buttons when running", () => {
    setRunning(true);
    for (const id of ["add-files", "add-folder", "open-settings"]) {
      const el = document.getElementById(id) as HTMLButtonElement;
      expect(el.disabled).toBe(true);
    }
  });

  it("sets state.running flag", () => {
    setRunning(true);
    expect(state.running).toBe(true);
    setRunning(false);
    expect(state.running).toBe(false);
  });
});
