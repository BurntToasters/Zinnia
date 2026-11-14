import { describe, it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { promptPassword } from "../prompt-modal";
import {
  describe7zError,
  looksLikePasswordRequiredError,
} from "../error-hints";
import {
  deriveBatchExtractDestinations,
  deriveOutputArchivePath,
  resolveExtractDestinationAutofill,
} from "../extract-path";
import { formatBatchNameList, pluralArchives } from "../archive/ops";
import { clearPasswordFields, runWithPasswordRetry } from "../archive/runtime";
import { runWithPasswordRetry as runExtractWindowRetry } from "../extract-window/password-retry";
import { clearBrowsePasswordFields, onBrowseSecretsForget } from "../ui/inputs";
import { refreshIcons } from "../icons";
import { decodeRun7zInvokePayload } from "./backend-ipc-test-utils";

vi.mock("../prompt-modal", () => ({
  promptPassword: vi.fn().mockResolvedValue({ kind: "cancel" }),
}));

vi.mock("../extract-window/dom", () => ({
  startIndeterminateProgress: vi.fn(),
  stopProgressAt: vi.fn(),
}));

const ENTER_PASSWORD_HEADER =
  "Could not list archive members for path safety: Enter password:";
const WRONG_PASSWORD_HEADER =
  "Could not list archive members for path safety: Wrong password?";
const RETRY_LABEL = "Incorrect password. Enter the archive password:";

describe("V-listing-lines: password phrases in file-name listing lines", () => {
  it("V-listing-lines: a '- wrong password.txt' listing line is not a prompt", () => {
    expect(
      looksLikePasswordRequiredError(
        "- wrong password.txt\n- enter password.md\n",
        "",
      ),
    ).toBe(false);
  });

  it("V-listing-lines: a '+ name' line is not a prompt", () => {
    expect(looksLikePasswordRequiredError("+ wrong password.txt", "")).toBe(
      false,
    );
  });

  it("V-listing-lines: a 'Path = ' property line is not a prompt", () => {
    expect(
      looksLikePasswordRequiredError(
        "Path = wrong password.txt\nFolder = -\n",
        "",
      ),
    ).toBe(false);
  });

  it("V-listing-lines: a progress record that names a member is not a prompt", () => {
    expect(
      looksLikePasswordRequiredError("  5% 2 - enter password.md", ""),
    ).toBe(false);
  });

  it("V-listing-lines: a wrong-password error on stderr still prompts", () => {
    expect(
      looksLikePasswordRequiredError("", "ERROR: Wrong password : archive.7z"),
    ).toBe(true);
  });

  it("V-listing-lines: an ERROR line on stdout still prompts", () => {
    expect(
      looksLikePasswordRequiredError("ERROR: Wrong password : archive.7z", ""),
    ).toBe(true);
  });

  it("V-listing-lines: a path-first '<path> : Wrong password' line on stdout still prompts", () => {
    expect(
      looksLikePasswordRequiredError("archive.7z : Wrong password", ""),
    ).toBe(true);
  });

  it("V-listing-lines: a password prompt printed on stdout still prompts", () => {
    expect(
      looksLikePasswordRequiredError(
        "Enter password (will not be echoed) :",
        "",
      ),
    ).toBe(true);
  });

  it("V-listing-lines: an error line after a listing line still prompts", () => {
    expect(
      looksLikePasswordRequiredError(
        "- ok.txt\nERROR: Wrong password : archive.7z",
        "",
      ),
    ).toBe(true);
  });

  it("V-listing-lines: describe7zError gives no password hint for a listing line", () => {
    expect(describe7zError("- wrong password.txt", "")).toBe("");
  });
});

describe("V-batch-folders: one folder per archive in a batch", () => {
  it("V-batch-folders: each archive gets its own folder under the destination", () => {
    expect(
      deriveBatchExtractDestinations("/out", ["/in/a.7z", "/in/b.zip"]),
    ).toEqual(["/out/a", "/out/b"]);
  });

  it("V-batch-folders: a Windows destination joins with a backslash", () => {
    expect(deriveBatchExtractDestinations("C:\\out", ["D:\\x\\a.7z"])).toEqual([
      "C:\\out\\a",
    ]);
  });

  it("V-batch-folders: a trailing separator on the destination is not doubled", () => {
    expect(deriveBatchExtractDestinations("/out/", ["/in/a.7z"])).toEqual([
      "/out/a",
    ]);
  });

  it("V-batch-folders: a repeated folder name gets a suffix instead of merging", () => {
    expect(
      deriveBatchExtractDestinations("/out", ["/in1/data.7z", "/in2/data.zip"]),
    ).toEqual(["/out/data", "/out/data (2)"]);
  });

  it("V-batch-folders: folder names are compared case-insensitively", () => {
    expect(
      deriveBatchExtractDestinations("C:\\out", [
        "C:\\in\\data.7z",
        "C:\\in\\DATA.tar",
      ]),
    ).toEqual(["C:\\out\\data", "C:\\out\\DATA (2)"]);
  });

  it("V-batch-folders: a suffix already taken by a derived name is skipped", () => {
    expect(
      deriveBatchExtractDestinations("/out", [
        "/in/a.7z",
        "/in/a.zip",
        "/in/a (2).7z",
      ]),
    ).toEqual(["/out/a", "/out/a (2)", "/out/a (2) (2)"]);
  });

  it("V-batch-folders: unsafe names fall back to _extracted and stay unique", () => {
    expect(
      deriveBatchExtractDestinations("/out", ["/in/CON.zip", "/in/b/CON.7z"]),
    ).toEqual(["/out/_extracted", "/out/_extracted (2)"]);
  });
});

describe("V-autofill-common-parent: destination autofill for several inputs", () => {
  it("V-autofill-common-parent: several archives autofill their common parent folder", () => {
    expect(
      resolveExtractDestinationAutofill("", null, "/in/a.7z", [
        "/in/a.7z",
        "/in/b.zip",
      ]),
    ).toBe("/in");
  });

  it("V-autofill-common-parent: one archive keeps the single-archive folder rule", () => {
    expect(
      resolveExtractDestinationAutofill("", null, "/downloads/new.zip", [
        "/downloads/new.zip",
      ]),
    ).toBe("/downloads/new");
  });

  it("V-autofill-common-parent: sibling folders autofill their nearest shared ancestor", () => {
    expect(
      resolveExtractDestinationAutofill("", null, "/x/y/a.7z", [
        "/x/y/a.7z",
        "/x/z/b.7z",
      ]),
    ).toBe("/x");
  });

  it("V-autofill-common-parent: a Windows folder shared by several archives is autofilled", () => {
    expect(
      resolveExtractDestinationAutofill("", null, "C:\\in\\a.7z", [
        "C:\\in\\a.7z",
        "C:\\in\\b.7z",
      ]),
    ).toBe("C:\\in");
  });

  it("V-autofill-common-parent: archives on different drives autofill nothing", () => {
    expect(
      resolveExtractDestinationAutofill("", null, "C:\\a\\x.7z", [
        "C:\\a\\x.7z",
        "D:\\b\\y.7z",
      ]),
    ).toBeNull();
  });
});

describe("V-output-never-relative: output archive path for protected sources", () => {
  it("V-output-never-relative: a protected source without a profile gives no bare name", () => {
    expect(
      deriveOutputArchivePath(
        ["C:\\Program Files\\Some App\\readme.txt"],
        "zip",
      ),
    ).toBeNull();
  });

  it("V-output-never-relative: a relative source gives no output path", () => {
    expect(deriveOutputArchivePath(["readme.txt"], "zip")).toBeNull();
  });
});

describe("V-name-list and V-plural: batch summary wording", () => {
  it("V-plural: counts use the computed plural", () => {
    expect(pluralArchives(1)).toBe("1 archive");
    expect(pluralArchives(2)).toBe("2 archives");
    expect(pluralArchives(0)).toBe("0 archives");
  });

  it("V-name-list: a list of five or fewer names is shown in full", () => {
    expect(formatBatchNameList(["a.7z", "b.7z"])).toBe("a.7z, b.7z");
  });

  it("V-name-list: a longer list shows five names and then a count", () => {
    expect(
      formatBatchNameList(["a.7z", "b.7z", "c.7z", "d.7z", "e.7z", "f.7z"]),
    ).toBe("a.7z, b.7z, c.7z, d.7z, e.7z, and 1 more");
  });
});

describe("V-runtime and V-extract-window: retry loop converts a rejected password run (M4)", () => {
  it("V-runtime-retry: keeps prompting when the retried run is rejected with a password error", async () => {
    const invokeMock = vi.mocked(invoke);
    const promptMock = vi.mocked(promptPassword);
    invokeMock
      .mockRejectedValueOnce(new Error(ENTER_PASSWORD_HEADER))
      .mockRejectedValueOnce(new Error(WRONG_PASSWORD_HEADER))
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        code: 0,
        archiveIdentityAfter: "archive-identity",
      });
    promptMock
      .mockResolvedValueOnce({ kind: "submit", value: "wrong-one" })
      .mockResolvedValueOnce({ kind: "submit", value: "right" });

    const result = await runWithPasswordRetry(
      ["x", "-o/tmp/out", "--", "/tmp/headers.7z"],
      true,
      "Extract",
      "archive-identity",
    );

    expect(result.code).toBe(0);
    expect(promptMock).toHaveBeenCalledTimes(2);
    expect(promptMock.mock.calls[1]?.[0]).toMatchObject({ label: RETRY_LABEL });
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(decodeRun7zInvokePayload(invokeMock.mock.calls[2]?.[1])).toEqual({
      args: ["x", "-o/tmp/out", "-pright", "--", "/tmp/headers.7z"],
      expectedArchiveIdentity: "archive-identity",
    });
  });

  it("V-runtime-non-password: an unrelated rejection inside the retry loop still propagates", async () => {
    const invokeMock = vi.mocked(invoke);
    const promptMock = vi.mocked(promptPassword);
    invokeMock
      .mockRejectedValueOnce(new Error(ENTER_PASSWORD_HEADER))
      .mockRejectedValueOnce(new Error("Archive snapshot disk unavailable"));
    promptMock.mockResolvedValueOnce({ kind: "submit", value: "wrong-one" });

    await expect(
      runWithPasswordRetry(["x", "-o/tmp/out", "--", "/tmp/headers.7z"], true),
    ).rejects.toThrow("Archive snapshot disk unavailable");
    expect(promptMock).toHaveBeenCalledTimes(1);
  });

  it("V-runtime-no-retry: a first-call password rejection is not prompted when retry is disabled", async () => {
    const invokeMock = vi.mocked(invoke);
    const promptMock = vi.mocked(promptPassword);
    invokeMock.mockRejectedValueOnce(new Error(ENTER_PASSWORD_HEADER));

    await expect(
      runWithPasswordRetry(["l", "--", "/tmp/headers.7z"], false),
    ).rejects.toThrow("Enter password:");
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("V-extract-window-retry: the quick-extract window keeps prompting after a rejected retry", async () => {
    const invokeMock = vi.mocked(invoke);
    const promptMock = vi.mocked(promptPassword);
    invokeMock
      .mockRejectedValueOnce(new Error(ENTER_PASSWORD_HEADER))
      .mockRejectedValueOnce(new Error(WRONG_PASSWORD_HEADER))
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0 });
    promptMock
      .mockResolvedValueOnce({ kind: "submit", value: "wrong-one" })
      .mockResolvedValueOnce({ kind: "submit", value: "right" });

    const result = await runExtractWindowRetry(
      ["x", "-o/tmp/out", "--", "/tmp/headers.7z"],
      () => false,
      "archive-identity",
    );

    expect(result.code).toBe(0);
    expect(promptMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("V-extract-window-non-password: the quick-extract window rethrows an unrelated retry rejection", async () => {
    const invokeMock = vi.mocked(invoke);
    const promptMock = vi.mocked(promptPassword);
    invokeMock
      .mockRejectedValueOnce(new Error(ENTER_PASSWORD_HEADER))
      .mockRejectedValueOnce(new Error("Archive snapshot disk unavailable"));
    promptMock.mockResolvedValueOnce({ kind: "submit", value: "wrong-one" });

    await expect(
      runExtractWindowRetry(
        ["x", "-o/tmp/out", "--", "/tmp/headers.7z"],
        () => false,
        "archive-identity",
      ),
    ).rejects.toThrow("Archive snapshot disk unavailable");
    expect(promptMock).toHaveBeenCalledTimes(1);
  });
});

describe("V-clear-password-fields and V-clear-browse-fields: remembered browse password (M5)", () => {
  it("V-clear-password-fields: clearing password fields after a run runs the forget listeners", () => {
    const forget = vi.fn();
    onBrowseSecretsForget(forget);
    clearPasswordFields();
    expect(forget).toHaveBeenCalled();
  });

  it("V-clear-browse-fields: clearing the browse password fields runs the forget listeners", () => {
    const forget = vi.fn();
    onBrowseSecretsForget(forget);
    clearBrowsePasswordFields();
    expect(forget).toHaveBeenCalled();
  });
});

describe("V-ban-icon: the cancelled completion icon is registered", () => {
  it("V-ban-icon: the ban icon renders, and an existing icon still renders", () => {
    document.body.innerHTML =
      '<i data-lucide="ban"></i><i data-lucide="check"></i>';
    refreshIcons();
    expect(document.querySelector("svg.lucide-ban")).not.toBeNull();
    expect(document.querySelector("svg.lucide-check")).not.toBeNull();
  });
});

const REAL_WRONG_PASSWORD_EXTRACT_STDOUT =
  "\r\n7-Zip 26.06 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-11-06\r\n\r\nScanning the drive for archives:\r\n  0M Scan C:\\zinnia\\zips\\\r                                \r1 file, 222 bytes (1 KiB)\r\n\r\nExtracting archive: C:\\zinnia\\zips\\encrypted.7z\r\n  0%\r    \r\r\nCan't open as archive: 1\r\nFiles: 0\r\nSize:       0\r\nCompressed: 0\r\n";
const REAL_WRONG_PASSWORD_EXTRACT_STDERR =
  "ERROR: C:\\zinnia\\zips\\encrypted.7z\r\nCannot open encrypted archive. Wrong password?\r\n\r\nERRORS:\r\nHeaders Error\r\n";
const REAL_WRONG_PASSWORD_PREFLIGHT_REJECTION =
  "Could not list archive members for path safety: ERROR: C:\\zinnia\\zips\\encrypted.7z : Cannot open encrypted archive. Wrong password?\r\n\r\nERRORS:\r\nHeaders Error";
const REAL_NO_PASSWORD_LIST_STDOUT =
  "\r\nEnter password (will not be echoed):\r\n";
const REAL_NO_PASSWORD_LIST_STDERR = "\r\n\r\nBreak signaled\r\n";
const REAL_SUCCESS_EXTRACT_STDOUT =
  "Path = C:\\zinnia\\zips\\encrypted.7z\r\nType = 7z\r\nMethod = LZMA2:12 7zAES\r\n\r\n  0%\r    \r- hello.txt\r\n100%\r    \rEverything is Ok\r\n\r\nSize:       23\r\nCompressed: 222\r\n";

describe("V-real-7z: real 7-Zip 26.06 output for the header-encrypted fixture", () => {
  it("V-real-7z: the wrong-password extraction output is a password error", () => {
    expect(
      looksLikePasswordRequiredError(
        REAL_WRONG_PASSWORD_EXTRACT_STDOUT,
        REAL_WRONG_PASSWORD_EXTRACT_STDERR,
      ),
    ).toBe(true);
  });

  it("V-real-7z: the preflight rejection the backend returns for a wrong password is a password error", () => {
    expect(
      looksLikePasswordRequiredError(
        "",
        REAL_WRONG_PASSWORD_PREFLIGHT_REJECTION,
      ),
    ).toBe(true);
  });

  it("V-real-7z: the no-password prompt printed on stdout is a password error", () => {
    expect(
      looksLikePasswordRequiredError(
        REAL_NO_PASSWORD_LIST_STDOUT,
        REAL_NO_PASSWORD_LIST_STDERR,
      ),
    ).toBe(true);
  });

  it("V-real-7z: a successful extraction that lists hello.txt is not a password error", () => {
    expect(
      looksLikePasswordRequiredError(REAL_SUCCESS_EXTRACT_STDOUT, ""),
    ).toBe(false);
  });
});
