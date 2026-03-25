import { describe, it, expect } from "vitest";
import { PRESETS } from "../presets";
import type { PresetConfig } from "../presets";

describe("PRESETS", () => {
  it("contains exactly the expected preset names", () => {
    const names = Object.keys(PRESETS);
    expect(names).toEqual(["store", "quick", "balanced", "high", "ultra"]);
  });

  it("store preset uses zip format with level 0", () => {
    expect(PRESETS.store.format).toBe("zip");
    expect(PRESETS.store.level).toBe("0");
    expect(PRESETS.store.solid).toBe("off");
  });

  it("ultra preset uses 7z format with level 9", () => {
    expect(PRESETS.ultra.format).toBe("7z");
    expect(PRESETS.ultra.level).toBe("9");
    expect(PRESETS.ultra.method).toBe("lzma2");
    expect(PRESETS.ultra.solid).toBe("solid");
  });

  it("all presets have every required field", () => {
    const requiredKeys: (keyof PresetConfig)[] = [
      "format",
      "level",
      "method",
      "dict",
      "wordSize",
      "solid",
    ];
    for (const [name, preset] of Object.entries(PRESETS)) {
      for (const key of requiredKeys) {
        expect(preset[key], `${name}.${key} should be defined`).toBeDefined();
        expect(typeof preset[key], `${name}.${key} should be a string`).toBe(
          "string",
        );
      }
    }
  });

  it("compression levels increase from store to ultra", () => {
    const levels = ["store", "quick", "balanced", "high", "ultra"].map((name) =>
      parseInt(PRESETS[name].level, 10),
    );
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1]);
    }
  });

  it("only 7z presets use solid mode", () => {
    for (const [, preset] of Object.entries(PRESETS)) {
      if (preset.format !== "7z") {
        expect(preset.solid).toBe("off");
      }
    }
  });
});
