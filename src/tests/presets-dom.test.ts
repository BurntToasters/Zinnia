import { describe, it, expect, beforeEach } from "vitest";
import {
  applyPreset,
  detectPreset,
  onCompressionOptionChange,
  updateCompressionOptionsForFormat,
  saveCustomPreset,
  deleteCustomPreset,
  refreshPresetDropdown,
  PRESETS,
} from "../presets";
import { state } from "../state";

function getSelectValue(id: string): string {
  return (document.getElementById(id) as HTMLSelectElement).value;
}

function setSelectValue(id: string, value: string) {
  (document.getElementById(id) as HTMLSelectElement).value = value;
}

beforeEach(() => {
  setSelectValue("format", "7z");
  setSelectValue("level", "5");
  setSelectValue("method", "lzma2");
  setSelectValue("dict", "64m");
  setSelectValue("word-size", "64");
  setSelectValue("solid", "off");
  setSelectValue("preset", "custom");
  state.currentSettings.customPresets = [];
});

describe("applyPreset", () => {
  it("applies store preset values", () => {
    applyPreset("store");
    expect(getSelectValue("format")).toBe("zip");
    expect(getSelectValue("level")).toBe("0");
    expect(getSelectValue("solid")).toBe("off");
  });

  it("applies ultra preset values", () => {
    applyPreset("ultra");
    expect(getSelectValue("format")).toBe("7z");
    expect(getSelectValue("level")).toBe("9");
    expect(getSelectValue("method")).toBe("lzma2");
    expect(getSelectValue("dict")).toBe("512m");
    expect(getSelectValue("word-size")).toBe("128");
    expect(getSelectValue("solid")).toBe("solid");
  });

  it("applies quick preset values", () => {
    applyPreset("quick");
    expect(getSelectValue("format")).toBe("zip");
    expect(getSelectValue("level")).toBe("1");
    expect(getSelectValue("method")).toBe("deflate");
  });

  it("does nothing for custom preset", () => {
    setSelectValue("format", "tar");
    applyPreset("custom");
    expect(getSelectValue("format")).toBe("tar");
  });

  it("does nothing for unknown preset", () => {
    setSelectValue("format", "tar");
    applyPreset("nonexistent");
    expect(getSelectValue("format")).toBe("tar");
  });

  it("applies all five named presets without error", () => {
    for (const name of Object.keys(PRESETS)) {
      expect(() => applyPreset(name)).not.toThrow();
    }
  });
});

describe("detectPreset", () => {
  it("detects store preset", () => {
    applyPreset("store");
    expect(detectPreset()).toBe("store");
  });

  it("detects ultra preset", () => {
    applyPreset("ultra");
    expect(detectPreset()).toBe("ultra");
  });

  it("detects balanced preset", () => {
    applyPreset("balanced");
    expect(detectPreset()).toBe("balanced");
  });

  it("detects high preset", () => {
    applyPreset("high");
    expect(detectPreset()).toBe("high");
  });

  it("detects quick preset", () => {
    applyPreset("quick");
    expect(detectPreset()).toBe("quick");
  });

  it('returns "custom" when no preset matches', () => {
    setSelectValue("format", "7z");
    setSelectValue("level", "3");
    setSelectValue("method", "ppmd");
    setSelectValue("dict", "32m");
    setSelectValue("word-size", "16");
    setSelectValue("solid", "off");
    expect(detectPreset()).toBe("custom");
  });

  it("round-trips all presets", () => {
    for (const name of Object.keys(PRESETS)) {
      applyPreset(name);
      expect(detectPreset()).toBe(name);
    }
  });
});

describe("custom presets", () => {
  it("saves the current config as a named custom preset", () => {
    setSelectValue("format", "7z");
    setSelectValue("level", "7");
    setSelectValue("dict", "128m");
    saveCustomPreset("My Backup");

    const saved = state.currentSettings.customPresets;
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("My Backup");
    expect(saved[0].level).toBe("7");
    expect(saved[0].dict).toBe("128m");
  });

  it("rejects empty and built-in preset names", () => {
    expect(() => saveCustomPreset("   ")).toThrow(/empty/);
    expect(() => saveCustomPreset("ultra")).toThrow(/built-in/);
  });

  it("overwrites a preset with the same name", () => {
    setSelectValue("level", "5");
    saveCustomPreset("Dup");
    setSelectValue("level", "9");
    saveCustomPreset("Dup");
    expect(state.currentSettings.customPresets).toHaveLength(1);
    expect(state.currentSettings.customPresets[0].level).toBe("9");
  });

  it("applies a saved custom preset by prefixed value", () => {
    setSelectValue("format", "zip");
    setSelectValue("level", "1");
    setSelectValue("method", "deflate");
    saveCustomPreset("Fast Zip");

    applyPreset("ultra");
    applyPreset("custom:Fast Zip");
    expect(getSelectValue("format")).toBe("zip");
    expect(getSelectValue("level")).toBe("1");
  });

  it("detects a matching custom preset", () => {
    setSelectValue("format", "7z");
    setSelectValue("level", "6");
    setSelectValue("dict", "32m");
    saveCustomPreset("Mid");
    expect(detectPreset()).toBe("custom:Mid");
  });

  it("deletes a custom preset", () => {
    saveCustomPreset("Temp");
    deleteCustomPreset("Temp");
    expect(state.currentSettings.customPresets).toHaveLength(0);
  });

  it("refreshes the dropdown with custom options before the custom anchor", () => {
    saveCustomPreset("Alpha");
    refreshPresetDropdown();
    const select = document.getElementById("preset") as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).toContain("custom:Alpha");
    expect(values.indexOf("custom:Alpha")).toBeLessThan(
      values.indexOf("custom"),
    );
  });
});

describe("updateCompressionOptionsForFormat", () => {
  it("populates 7z methods: lzma2, lzma, ppmd, bzip2", () => {
    updateCompressionOptionsForFormat("7z");
    const methodSelect = document.getElementById("method") as HTMLSelectElement;
    const options = Array.from(methodSelect.options).map((o) => o.value);
    expect(options).toEqual(["lzma2", "lzma", "ppmd", "bzip2"]);
    expect(methodSelect.disabled).toBe(false);
  });

  it("populates zip methods: deflate, bzip2, lzma", () => {
    updateCompressionOptionsForFormat("zip");
    const methodSelect = document.getElementById("method") as HTMLSelectElement;
    const options = Array.from(methodSelect.options).map((o) => o.value);
    expect(options).toEqual(["deflate", "bzip2", "lzma"]);
    expect(methodSelect.disabled).toBe(false);
  });

  it("disables method with N/A for tar", () => {
    updateCompressionOptionsForFormat("tar");
    const methodSelect = document.getElementById("method") as HTMLSelectElement;
    expect(methodSelect.disabled).toBe(true);
    expect(methodSelect.options[0].textContent).toBe("N/A");
  });

  it("disables method with N/A for gzip", () => {
    updateCompressionOptionsForFormat("gzip");
    const methodSelect = document.getElementById("method") as HTMLSelectElement;
    expect(methodSelect.disabled).toBe(true);
  });

  it("disables method with N/A for bzip2", () => {
    updateCompressionOptionsForFormat("bzip2");
    const methodSelect = document.getElementById("method") as HTMLSelectElement;
    expect(methodSelect.disabled).toBe(true);
  });

  it("disables method with N/A for xz", () => {
    updateCompressionOptionsForFormat("xz");
    const methodSelect = document.getElementById("method") as HTMLSelectElement;
    expect(methodSelect.disabled).toBe(true);
  });

  it("preserves current method value if still valid after format change", () => {
    updateCompressionOptionsForFormat("7z");
    const methodSelect = document.getElementById("method") as HTMLSelectElement;
    methodSelect.value = "ppmd";
    updateCompressionOptionsForFormat("7z");
    expect(getSelectValue("method")).toBe("ppmd");
  });

  it("bumps level from 0 to 5 for tar-family formats", () => {
    setSelectValue("level", "0");
    updateCompressionOptionsForFormat("tar");
    expect(getSelectValue("level")).toBe("5");
  });

  it("leaves level 0 for zip", () => {
    setSelectValue("level", "0");
    updateCompressionOptionsForFormat("zip");
    expect(getSelectValue("level")).toBe("0");
  });
});

describe("onCompressionOptionChange", () => {
  it("updates preset selector to matching preset", () => {
    applyPreset("store");
    onCompressionOptionChange();
    expect(getSelectValue("preset")).toBe("store");
  });

  it('sets preset to "custom" when no match', () => {
    setSelectValue("format", "7z");
    setSelectValue("level", "3");
    setSelectValue("method", "ppmd");
    setSelectValue("dict", "16m");
    setSelectValue("word-size", "16");
    setSelectValue("solid", "off");
    onCompressionOptionChange();
    expect(getSelectValue("preset")).toBe("custom");
  });
});
