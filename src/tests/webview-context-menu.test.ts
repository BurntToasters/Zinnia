import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installNativeWebviewContextMenuGuard,
  isNativeWebviewContextMenuAllowed,
  setNativeWebviewContextMenuAllowed,
} from "../webview-context-menu";

function fireContextMenu(): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

describe("native webview context menu guard", () => {
  beforeEach(() => {
    setNativeWebviewContextMenuAllowed(false);
    installNativeWebviewContextMenuGuard();
  });

  afterEach(() => {
    setNativeWebviewContextMenuAllowed(false);
  });

  it("blocks the default menu until debug mode allows it", () => {
    expect(isNativeWebviewContextMenuAllowed()).toBe(false);
    expect(fireContextMenu().defaultPrevented).toBe(true);

    setNativeWebviewContextMenuAllowed(true);
    expect(isNativeWebviewContextMenuAllowed()).toBe(true);
    expect(fireContextMenu().defaultPrevented).toBe(false);

    setNativeWebviewContextMenuAllowed(false);
    expect(fireContextMenu().defaultPrevented).toBe(true);
  });

  it("installs the document listener only once", () => {
    const added: unknown[] = [];
    const original = document.addEventListener.bind(document);
    document.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      added.push(type);
      original(type, listener, options);
    }) as typeof document.addEventListener;

    try {
      installNativeWebviewContextMenuGuard();
      installNativeWebviewContextMenuGuard();
      expect(added.filter((type) => type === "contextmenu")).toHaveLength(0);
    } finally {
      document.addEventListener = original;
    }
  });
});
