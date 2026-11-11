import { expect, it } from "vitest";
import { renderShortcuts } from "../shortcuts";

it("renders shortcut help with platform alternatives and replaces old rows on refresh", () => {
  const list = document.createElement("dl");
  list.id = "shortcut-list";
  document.body.append(list);
  try {
    renderShortcuts();
    const firstRender = list.innerHTML;
    renderShortcuts();
    expect(list.innerHTML).toBe(firstRender);
    const rows = Array.from(list.children);
    const run = rows.find(
      (row) =>
        row.querySelector("dd")?.textContent === "Run the current operation",
    )!;
    expect(run.querySelector("dt")?.textContent).toBe("Ctrl/⌘ + Enter");
    expect(
      Array.from(run.querySelectorAll("kbd"), (key) => key.textContent),
    ).toEqual(["Ctrl", "⌘", "Enter"]);
    expect(
      list.querySelector('[data-workspace="basic"]')?.textContent,
    ).toContain("Run the visible Basic action");
    expect(
      list.querySelector('[data-workspace="power"]')?.textContent,
    ).toContain("Move between entries in Extract selected");
    expect(
      rows
        .find(
          (row) =>
            row.querySelector("dd")?.textContent ===
            "Move between settings tabs",
        )
        ?.querySelector("dt")?.textContent,
    ).toBe("← →");
  } finally {
    list.remove();
  }
  expect(() => renderShortcuts()).not.toThrow();
});
