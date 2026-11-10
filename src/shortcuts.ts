export type ShortcutWorkspace = "all" | "power" | "basic";

export interface ShortcutEntry {
  readonly workspace: ShortcutWorkspace;
  readonly keys: readonly (readonly string[])[];
  readonly joiner?: " + " | " ";
  readonly description: string;
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  {
    workspace: "all",
    keys: [["Ctrl", "⌘"], ["Enter"]],
    description: "Run the current operation",
  },
  {
    workspace: "all",
    keys: [["Ctrl", "⌘"], [","]],
    description: "Open Settings",
  },
  {
    workspace: "all",
    keys: [["Esc"]],
    description: "Close the open dialog",
  },
  {
    workspace: "all",
    keys: [["?"]],
    description: "Show this help",
  },
  {
    workspace: "all",
    keys: [["←"], ["→"]],
    joiner: " ",
    description: "Move between settings tabs",
  },
  {
    workspace: "basic",
    keys: [["Enter"]],
    description:
      "Run the visible Basic action (not while a button or link has focus)",
  },
  {
    workspace: "basic",
    keys: [["Esc"]],
    description: "Blur the focused field, or return home from a Basic view",
  },
  {
    workspace: "basic",
    keys: [["←"], ["→"]],
    joiner: " ",
    description: "Move between Basic tabs",
  },
  {
    workspace: "basic",
    keys: [["Home"], ["End"]],
    joiner: " ",
    description: "Jump to the first or last Basic tab",
  },
  {
    workspace: "power",
    keys: [["↑"], ["↓"]],
    joiner: " ",
    description: "Move between entries in Extract Selected Entries",
  },
  {
    workspace: "power",
    keys: [["←"], ["→"]],
    joiner: " ",
    description: "Collapse or expand a folder in Extract Selected Entries",
  },
  {
    workspace: "power",
    keys: [["Space", "Enter"]],
    description: "Toggle the focused entry in Extract Selected Entries",
  },
];

function buildKeys(entry: ShortcutEntry): HTMLElement {
  const dt = document.createElement("dt");
  entry.keys.forEach((alternatives, slot) => {
    if (slot > 0) dt.append(entry.joiner ?? " + ");
    alternatives.forEach((key, index) => {
      if (index > 0) dt.append("/");
      const kbd = document.createElement("kbd");
      kbd.textContent = key;
      dt.append(kbd);
    });
  });
  return dt;
}

function buildRow(entry: ShortcutEntry): HTMLElement {
  const row = document.createElement("div");
  row.className = "shortcut-list__row";
  row.dataset.workspace = entry.workspace;
  const dd = document.createElement("dd");
  dd.textContent = entry.description;
  row.append(buildKeys(entry), dd);
  return row;
}

export function renderShortcuts(): void {
  const list = document.getElementById("shortcut-list");
  if (!list) return;
  list.replaceChildren(...SHORTCUTS.map(buildRow));
}
