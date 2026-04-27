import { beforeEach, describe, expect, it, vi } from "vitest";
import { open, save } from "@tauri-apps/plugin-dialog";
import { state } from "../state";

const renderInputsMock = vi.fn();
const setBrowsePasswordFieldVisibleMock = vi.fn();
let mode: "add" | "extract" | "browse" = "add";

vi.mock("../ui", () => ({
  getMode: () => mode,
  renderInputs: (...args: unknown[]) => renderInputsMock(...args),
  setBrowsePasswordFieldVisible: (...args: unknown[]) =>
    setBrowsePasswordFieldVisibleMock(...args),
}));

import { addFiles, addFolder, chooseExtract, chooseOutput } from "../files";

const openMock = vi.mocked(open);
const saveMock = vi.mocked(save);

beforeEach(() => {
  mode = "add";
  state.inputs.length = 0;
  state.lastAutoOutputPath = "/tmp/auto-output.7z";
  state.lastAutoExtractDestination = "/tmp/auto-extract";
  (document.getElementById("output-path") as HTMLInputElement).value = "";
  (document.getElementById("extract-path") as HTMLInputElement).value = "";
  openMock.mockReset();
  saveMock.mockReset();
  renderInputsMock.mockReset();
  setBrowsePasswordFieldVisibleMock.mockReset();
});

describe("chooseOutput", () => {
  it("stores selected output path", async () => {
    (document.getElementById("format") as HTMLSelectElement).value = "zip";
    saveMock.mockResolvedValue("/tmp/out.zip");

    await chooseOutput();

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Choose output archive",
        defaultPath: expect.any(String),
      }),
    );
    expect(
      (document.getElementById("output-path") as HTMLInputElement).value,
    ).toBe("/tmp/out.zip");
    expect(state.lastAutoOutputPath).toBeNull();
  });

  it("keeps previous value when save is cancelled", async () => {
    (document.getElementById("output-path") as HTMLInputElement).value =
      "/tmp/original.7z";
    saveMock.mockResolvedValue(null);

    await chooseOutput();

    expect(
      (document.getElementById("output-path") as HTMLInputElement).value,
    ).toBe("/tmp/original.7z");
    expect(state.lastAutoOutputPath).toBe("/tmp/auto-output.7z");
  });
});

describe("chooseExtract", () => {
  it("stores selected extract destination", async () => {
    openMock.mockResolvedValue("/tmp/extract-here");

    await chooseExtract();

    expect(openMock).toHaveBeenCalledWith({
      title: "Choose destination folder",
      directory: true,
    });
    expect(
      (document.getElementById("extract-path") as HTMLInputElement).value,
    ).toBe("/tmp/extract-here");
    expect(state.lastAutoExtractDestination).toBeNull();
  });

  it("ignores non-string selections", async () => {
    openMock.mockResolvedValue(["/tmp/a", "/tmp/b"]);

    await chooseExtract();

    expect(
      (document.getElementById("extract-path") as HTMLInputElement).value,
    ).toBe("");
    expect(state.lastAutoExtractDestination).toBe("/tmp/auto-extract");
  });
});

describe("addFiles", () => {
  it("does nothing when selection is cancelled", async () => {
    openMock.mockResolvedValue(null);

    await addFiles();

    expect(state.inputs).toEqual([]);
    expect(renderInputsMock).not.toHaveBeenCalled();
  });

  it("adds unique paths and rerenders", async () => {
    openMock.mockResolvedValue(["/tmp/a.txt", "/tmp/a.txt", "/tmp/b.txt"]);

    await addFiles();

    expect(state.inputs).toEqual(["/tmp/a.txt", "/tmp/b.txt"]);
    expect(renderInputsMock).toHaveBeenCalledOnce();
  });

  it("hides browse password when primary input changes in browse mode", async () => {
    mode = "browse";
    openMock.mockResolvedValue(["/tmp/new-primary.7z"]);

    await addFiles();

    expect(setBrowsePasswordFieldVisibleMock).toHaveBeenCalledWith(false);
  });

  it("does not hide browse password when primary input is unchanged", async () => {
    mode = "browse";
    state.inputs.push("/tmp/original.7z");
    openMock.mockResolvedValue(["/tmp/original.7z", "/tmp/extra.7z"]);

    await addFiles();

    expect(setBrowsePasswordFieldVisibleMock).not.toHaveBeenCalled();
  });
});

describe("addFolder", () => {
  it("does nothing when selection is cancelled", async () => {
    openMock.mockResolvedValue(null);

    await addFolder();

    expect(state.inputs).toEqual([]);
    expect(renderInputsMock).not.toHaveBeenCalled();
  });

  it("adds folder and rerenders", async () => {
    openMock.mockResolvedValue("/tmp/my-folder");

    await addFolder();

    expect(state.inputs).toEqual(["/tmp/my-folder"]);
    expect(renderInputsMock).toHaveBeenCalledOnce();
  });

  it("hides browse password when browse primary changes", async () => {
    mode = "browse";
    openMock.mockResolvedValue("/tmp/new-folder");

    await addFolder();

    expect(setBrowsePasswordFieldVisibleMock).toHaveBeenCalledWith(false);
  });

  it("still rerenders for duplicate folder but does not toggle browse password", async () => {
    mode = "browse";
    state.inputs.push("/tmp/existing-folder");
    openMock.mockResolvedValue("/tmp/existing-folder");

    await addFolder();

    expect(state.inputs).toEqual(["/tmp/existing-folder"]);
    expect(renderInputsMock).toHaveBeenCalledOnce();
    expect(setBrowsePasswordFieldVisibleMock).not.toHaveBeenCalled();
  });
});
