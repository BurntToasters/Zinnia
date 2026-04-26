import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeLicensesModal, openLicensesModal } from "../licenses";

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  const overlay = document.getElementById("licenses-overlay") as HTMLElement;
  overlay.hidden = true;
  const list = document.getElementById("licenses-list") as HTMLElement;
  list.innerHTML = "";
});

describe("licenses modal", () => {
  it("renders bundled and loaded license entries", async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path === "/licenses.json") {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            "pkg-npm": {
              licenses: "MIT",
              repository: "https://example.com/npm",
            },
          }),
        };
      }
      if (path === "/licenses-cargo.json") {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            "pkg-cargo": {
              licenses: "Apache-2.0",
              repository: "https://example.com/cargo",
            },
          }),
        };
      }
      return {
        status: 404,
        ok: false,
        json: async () => ({}),
      };
    });

    const trigger = document.createElement("button");
    trigger.id = "licenses-trigger";
    document.body.appendChild(trigger);

    openLicensesModal(trigger);
    await flushAsync();
    await flushAsync();

    const overlay = document.getElementById("licenses-overlay") as HTMLElement;
    const list = document.getElementById("licenses-list") as HTMLElement;

    expect(overlay.hidden).toBe(false);
    expect(list.textContent).toContain("Twemoji");
    expect(list.textContent).toContain("7-Zip");
    expect(list.textContent).toContain("pkg-npm");
    expect(list.textContent).toContain("pkg-cargo");
    expect(list.querySelectorAll("details.license-card").length).toBe(4);

    closeLicensesModal();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("shows failure message when loading fails", async () => {
    fetchMock.mockResolvedValue({
      status: 500,
      ok: false,
      json: async () => ({}),
    });

    openLicensesModal();
    await flushAsync();
    await flushAsync();

    const list = document.getElementById("licenses-list") as HTMLElement;
    expect(list.textContent).toBe("Failed to load licenses.");
  });

  it("falls back to show-licenses element on close when no trigger is provided", () => {
    const fallback = document.createElement("button");
    fallback.id = "show-licenses";
    document.body.appendChild(fallback);

    openLicensesModal();
    closeLicensesModal();

    expect(document.activeElement).toBe(fallback);
    fallback.remove();
  });
});
