import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function luminance(hex: string): number {
  return rgb(hex)
    .map((component) => component / 255)
    .map((component) =>
      component <= 0.04045
        ? component / 12.92
        : ((component + 0.055) / 1.055) ** 2.4,
    )
    .reduce(
      (sum, component, index) =>
        sum + component * ([0.2126, 0.7152, 0.0722][index] ?? 0),
      0,
    );
}

function contrast(left: string, right: string): number {
  const [bright, dark] = [luminance(left), luminance(right)].sort(
    (a, b) => b - a,
  );
  return (bright + 0.05) / (dark + 0.05);
}

function variables(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [
      match[1],
      match[2],
    ]),
  );
}

describe("theme text contrast", () => {
  it("keeps normal text and accent links at WCAG AA contrast", () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "src/variables.css"),
      "utf8",
    );
    const dark = variables(
      css.match(/:root,\s*\[data-theme="dark"\]\s*{([\s\S]*?)\n}/)?.[1] ?? "",
    );
    const light = variables(
      css.match(/\[data-theme="light"\]\s*{([\s\S]*?)\n}/)?.[1] ?? "",
    );
    for (const theme of [dark, light]) {
      const surfaces = [theme.get("bg"), theme.get("surface")];
      for (const foreground of [
        theme.get("text"),
        theme.get("text-secondary"),
        theme.get("accent-fg"),
        theme.get("danger-fg"),
      ]) {
        for (const background of surfaces) {
          expect(contrast(foreground!, background!)).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      }
      expect(
        contrast(theme.get("text-on-accent")!, theme.get("accent")!),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
