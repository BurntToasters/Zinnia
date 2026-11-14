import { beforeEach, describe, expect, it } from "vitest";
import "./setup-dom";
import { renderShortcuts } from "../shortcuts";
import { closeShortcutsModal, openShortcutsModal } from "../power-shortcuts";

function ensureShortcutList(): HTMLElement {
  let list = document.getElementById("shortcut-list");
  if (!list) {
    list = document.createElement("dl");
    list.id = "shortcut-list";
    document.querySelector("#shortcuts-overlay .modal")!.appendChild(list);
  }
  return list;
}

function workspacesIn(list: HTMLElement): string[] {
  return [
    ...new Set(
      Array.from(
        list.querySelectorAll<HTMLElement>(".shortcut-list__row"),
        (row) => row.dataset.workspace ?? "",
      ),
    ),
  ].sort();
}

function setWorkspaceMode(mode: string | undefined): void {
  const app = document.getElementById("app")!;
  if (mode === undefined) delete app.dataset.workspaceMode;
  else app.dataset.workspaceMode = mode;
}

describe("beta2 ui markup: shortcuts follow the open workspace", () => {
  beforeEach(() => {
    const overlay = document.getElementById("shortcuts-overlay") as HTMLElement;
    overlay.hidden = true;
    setWorkspaceMode("basic");
    ensureShortcutList();
  });

  it("renders only the rows of the requested workspace, and every row when none is given", () => {
    const list = ensureShortcutList();
    renderShortcuts("power");
    expect(workspacesIn(list)).toEqual(["all", "power"]);
    renderShortcuts("basic");
    expect(workspacesIn(list)).toEqual(["all", "basic"]);
    renderShortcuts();
    expect(workspacesIn(list)).toEqual(["all", "basic", "power"]);
  });

  it("decides the rows when the dialog opens, so a workspace change shows on the next open", () => {
    const list = ensureShortcutList();
    setWorkspaceMode("power");
    openShortcutsModal();
    expect(workspacesIn(list)).toEqual(["all", "power"]);
    closeShortcutsModal();

    setWorkspaceMode("basic");
    openShortcutsModal();
    expect(workspacesIn(list)).toEqual(["all", "basic"]);
    closeShortcutsModal();
  });

  it("shows Basic rows when the app has no workspace mode", () => {
    const list = ensureShortcutList();
    setWorkspaceMode(undefined);
    openShortcutsModal();
    expect(workspacesIn(list)).toEqual(["all", "basic"]);
    closeShortcutsModal();
  });
});
