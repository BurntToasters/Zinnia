import { describe, it, expect, beforeEach } from "vitest";
import { buildArgs, buildExtractArgsFor } from "../archive";
import { state } from "../state";

function setSelectValue(id: string, value: string) {
  const el = document.getElementById(id) as HTMLSelectElement;
  el.value = value;
}

function setInputValue(id: string, value: string) {
  const el = document.getElementById(id) as HTMLInputElement;
  el.value = value;
}

function setChecked(id: string, checked: boolean) {
  const el = document.getElementById(id) as HTMLInputElement;
  el.checked = checked;
}

beforeEach(() => {
  state.inputs = [];
  state.running = false;
  const appEl = document.getElementById("app") as HTMLElement;
  appEl.dataset.mode = "add";

  setSelectValue("format", "7z");
  setSelectValue("level", "5");
  setSelectValue("method", "lzma2");
  setSelectValue("dict", "64m");
  setSelectValue("word-size", "64");
  setSelectValue("solid", "off");
  setSelectValue("path-mode", "relative");
  setInputValue("output-path", "");
  setInputValue("threads", "");
  setInputValue("password", "");
  setInputValue("extra-args", "");
  setChecked("encrypt-headers", false);
  setChecked("sfx", false);
  setChecked("delete-after", false);
  setInputValue("extract-path", "");
  setInputValue("extract-password", "");
  setInputValue("extract-extra-args", "");
});

describe("buildArgs (add mode)", () => {
  it("builds basic 7z create command", () => {
    state.inputs = ["file1.txt", "file2.txt"];
    setInputValue("output-path", "output.7z");

    const args = buildArgs();
    expect(args[0]).toBe("a");
    expect(args).toContain("-t7z");
    expect(args).toContain("-mx=5");
    expect(args).toContain("-m0=lzma2");
    expect(args).toContain("-md=64m");
    expect(args).toContain("-mfb=64");
    expect(args).toContain("output.7z");
    expect(args).toContain("file1.txt");
    expect(args).toContain("file2.txt");
  });

  it("includes solid mode switch", () => {
    state.inputs = ["a.txt"];
    setInputValue("output-path", "out.7z");
    setSelectValue("solid", "solid");

    const args = buildArgs();
    expect(args).toContain("-ms=on");
  });

  it("includes custom solid block size", () => {
    state.inputs = ["a.txt"];
    setInputValue("output-path", "out.7z");
    setSelectValue("solid", "4g");

    const args = buildArgs();
    expect(args).toContain("-ms=4g");
  });

  it("omits solid switch when off", () => {
    state.inputs = ["a.txt"];
    setInputValue("output-path", "out.7z");
    setSelectValue("solid", "off");

    const args = buildArgs();
    expect(args.some((a) => a.startsWith("-ms="))).toBe(false);
  });

  it("includes threads switch", () => {
    state.inputs = ["a.txt"];
    setInputValue("output-path", "out.7z");
    setInputValue("threads", "4");

    const args = buildArgs();
    expect(args).toContain("-mmt=4");
  });

  it("includes absolute path mode switch", () => {
    state.inputs = ["a.txt"];
    setInputValue("output-path", "out.7z");
    setSelectValue("path-mode", "absolute");

    const args = buildArgs();
    expect(args).toContain("-spf");
  });

  it("omits path mode switch for relative", () => {
    state.inputs = ["a.txt"];
    setInputValue("output-path", "out.7z");
    setSelectValue("path-mode", "relative");

    const args = buildArgs();
    expect(args).not.toContain("-spf");
  });

  it("includes password switch", () => {
    state.inputs = ["a.txt"];
    setInputValue("output-path", "out.7z");
    setInputValue("password", "secret123");

    const args = buildArgs();
    expect(args).toContain("-psecret123");
  });

  it("includes encrypt-headers switch for 7z with password", () => {
    state.inputs = ["a.txt"];
    setInputValue("output-path", "out.7z");
    setInputValue("password", "secret123");
    setChecked("encrypt-headers", true);

    const args = buildArgs();
    expect(args).toContain("-mhe=on");
  });

  it("includes sfx switch", () => {
    state.inputs = ["a.txt"];
    setInputValue("output-path", "out.7z");
    setChecked("sfx", true);

    const args = buildArgs();
    expect(args).toContain("-sfx");
  });

  it("includes delete-after switch", () => {
    state.inputs = ["a.txt"];
    setInputValue("output-path", "out.7z");
    setChecked("delete-after", true);

    const args = buildArgs();
    expect(args).toContain("-sdel");
  });

  it("throws when output path is empty", () => {
    state.inputs = ["a.txt"];
    setInputValue("output-path", "");

    expect(() => buildArgs()).toThrow("Choose an output archive path.");
  });

  it("throws when no inputs provided", () => {
    state.inputs = [];
    setInputValue("output-path", "out.7z");

    expect(() => buildArgs()).toThrow("Add at least one input.");
  });

  it("builds zip format command", () => {
    state.inputs = ["a.txt"];
    setInputValue("output-path", "out.zip");
    setSelectValue("format", "zip");
    setSelectValue("method", "deflate");

    const args = buildArgs();
    expect(args).toContain("-tzip");
    expect(args).toContain("-m0=deflate");
  });

  it("includes extra args", () => {
    state.inputs = ["a.txt"];
    setInputValue("output-path", "out.7z");
    setInputValue("extra-args", "-bb3");

    const args = buildArgs();
    expect(args).toContain("-bb3");
  });
});

describe("buildArgs (extract mode)", () => {
  it("throws when no archive selected", () => {
    const appEl = document.getElementById("app") as HTMLElement;
    appEl.dataset.mode = "extract";
    state.inputs = [];

    expect(() => buildArgs()).toThrow("Select an archive to extract.");
  });

  it("delegates to buildExtractArgsFor in extract mode", () => {
    const appEl = document.getElementById("app") as HTMLElement;
    appEl.dataset.mode = "extract";
    state.inputs = ["archive.7z"];
    setInputValue("extract-path", "/tmp/out");

    const args = buildArgs();
    expect(args[0]).toBe("x");
    expect(args).toContain("archive.7z");
    expect(args).toContain("-o/tmp/out");
  });
});

describe("buildExtractArgsFor", () => {
  it("builds basic extract command with destination", () => {
    setInputValue("extract-path", "/tmp/extract");
    setInputValue("extract-password", "");
    setInputValue("extract-extra-args", "");

    const args = buildExtractArgsFor("test.7z");
    expect(args[0]).toBe("x");
    expect(args).toContain("test.7z");
    expect(args).toContain("-o/tmp/extract");
  });

  it("uses destinationOverride when provided", () => {
    setInputValue("extract-path", "/tmp/default");
    const args = buildExtractArgsFor("test.7z", [], undefined, "/tmp/override");
    expect(args).toContain("-o/tmp/override");
    expect(args).not.toContain("-o/tmp/default");
  });

  it("uses passwordOverride when provided", () => {
    setInputValue("extract-path", "/tmp/out");
    setInputValue("extract-password", "form-pass");
    const args = buildExtractArgsFor("test.7z", [], "override-pass");
    expect(args).toContain("-poverride-pass");
  });

  it("reads password from form when no override", () => {
    setInputValue("extract-path", "/tmp/out");
    setInputValue("extract-password", "mypass");

    const args = buildExtractArgsFor("test.7z");
    expect(args).toContain("-pmypass");
  });

  it("throws when destination is empty", () => {
    setInputValue("extract-path", "");
    expect(() => buildExtractArgsFor("test.7z")).toThrow(
      "Choose a destination folder.",
    );
  });

  it("passes selectedPaths for selective extraction", () => {
    setInputValue("extract-path", "/tmp/out");
    const args = buildExtractArgsFor("test.7z", ["docs/readme.md"]);
    expect(args).toContain("docs/readme.md");
  });
});
