import { describe, it, expect } from "vitest";
import {
  deriveExtractDestinationPath,
  deriveExtractFolderName,
  deriveOutputArchivePath,
  isPreferredCompressParent,
  resolveExtractDestinationAutofill,
  resolveOutputArchiveAutofill,
  shouldAutofillExtractDestination,
  shouldAutofillOutputPath,
} from "../extract-path";

describe("deriveExtractDestinationPath", () => {
  it("strips known archive extensions", () => {
    expect(deriveExtractDestinationPath("/downloads/example.zip")).toBe(
      "/downloads/example",
    );
    expect(deriveExtractDestinationPath("C:\\downloads\\example.7z")).toBe(
      "C:\\downloads\\example",
    );
    expect(deriveExtractDestinationPath("C:\\example.txz")).toBe("C:\\example");
  });

  it("strips compound extensions like .tar.gz", () => {
    expect(deriveExtractDestinationPath("/downloads/example.tar.gz")).toBe(
      "/downloads/example",
    );
    expect(deriveExtractDestinationPath("/downloads/example.tgz")).toBe(
      "/downloads/example",
    );
  });

  it("appends _extracted for unknown extensions", () => {
    expect(deriveExtractDestinationPath("/downloads/example.custom")).toBe(
      "/downloads/example.custom_extracted",
    );
  });

  it("appends _extracted for no extension", () => {
    expect(deriveExtractDestinationPath("/downloads/example")).toBe(
      "/downloads/example_extracted",
    );
  });

  it("keeps POSIX and Windows drive roots as parents", () => {
    expect(deriveExtractDestinationPath("/example.zip")).toBe("/example");
    expect(deriveExtractDestinationPath("C:/example.zip")).toBe("C:/example");
    expect(deriveExtractDestinationPath("C:\\example.zip")).toBe("C:\\example");
  });

  it("returns empty for blank input", () => {
    expect(deriveExtractDestinationPath("")).toBe("");
    expect(deriveExtractFolderName("")).toBe("");
  });

  it("preserves leading and trailing whitespace in legitimate file names", () => {
    expect(deriveExtractDestinationPath("/downloads/ archive.zip")).toBe(
      "/downloads/ archive",
    );
    expect(deriveExtractDestinationPath("/downloads/archive.zip ")).toBe(
      "/downloads/archive.zip _extracted",
    );
  });
});

describe("deriveExtractFolderName", () => {
  it("strips compound extensions", () => {
    expect(deriveExtractFolderName("archive.tar.bz2")).toBe("archive");
  });

  it("appends _extracted for unknown extensions", () => {
    expect(deriveExtractFolderName("archive.bin")).toBe(
      "archive.bin_extracted",
    );
  });
});

describe("shouldAutofillExtractDestination", () => {
  it("returns true when destination is empty", () => {
    expect(shouldAutofillExtractDestination("", null)).toBe(true);
  });

  it("returns true when destination matches previous autofill (trimmed)", () => {
    expect(
      shouldAutofillExtractDestination(
        " /downloads/example ",
        "/downloads/example",
      ),
    ).toBe(true);
  });

  it("returns false when user has customized destination", () => {
    expect(
      shouldAutofillExtractDestination(
        "/downloads/custom-target",
        "/downloads/example",
      ),
    ).toBe(false);
  });
});

describe("resolveExtractDestinationAutofill", () => {
  it("autofills when previous is null", () => {
    expect(
      resolveExtractDestinationAutofill("", null, "/downloads/new.zip"),
    ).toBe("/downloads/new");
  });

  it("updates when destination matches previous autofill", () => {
    expect(
      resolveExtractDestinationAutofill(
        "/downloads/example",
        "/downloads/example",
        "/downloads/new.zip",
      ),
    ).toBe("/downloads/new");
  });

  it("returns null when user has customized destination", () => {
    expect(
      resolveExtractDestinationAutofill(
        "/downloads/custom",
        "/downloads/example",
        "/downloads/new.zip",
      ),
    ).toBeNull();
  });
});

describe("deriveOutputArchivePath", () => {
  it("derives from a folder input", () => {
    expect(deriveOutputArchivePath(["/home/user/folder"], "7z")).toBe(
      "/home/user/folder.7z",
    );
  });

  it("derives from a file input", () => {
    expect(deriveOutputArchivePath(["C:\\docs\\readme.txt"], "zip")).toBe(
      "C:\\docs\\readme.txt.zip",
    );
  });

  it("strips trailing separators", () => {
    expect(deriveOutputArchivePath(["/home/user/folder/"], "7z")).toBe(
      "/home/user/folder.7z",
    );
  });

  it("uses customName when provided", () => {
    expect(deriveOutputArchivePath(["/home/user/folder"], "7z", "backup")).toBe(
      "/home/user/backup.7z",
    );
  });

  it("returns null for empty inputs", () => {
    expect(deriveOutputArchivePath([], "7z")).toBeNull();
  });

  it("preserves whitespace-only names rather than rewriting them", () => {
    expect(deriveOutputArchivePath(["/home/user/  "], "7z")).toBe(
      "/home/user/  .7z",
    );
  });

  it("avoids Start Menu and Program Files parents (Windows .lnk defaults)", () => {
    expect(
      deriveOutputArchivePath(
        [
          "C:\\Users\\dev\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\GitHub Desktop.lnk",
        ],
        "7z",
      ),
    ).toBe("C:\\Users\\dev\\Desktop\\GitHub Desktop.lnk.7z");
    expect(
      deriveOutputArchivePath(
        ["C:\\Program Files\\Some App\\readme.txt"],
        "zip",
      ),
    ).toBe("readme.txt.zip");
  });

  it("still allows paths under Microsoft\\Windows user folders", () => {
    expect(
      isPreferredCompressParent(
        "C:\\Users\\dev\\AppData\\Local\\Microsoft\\Windows\\Fonts",
      ),
    ).toBe(true);
  });
});

describe("shouldAutofillOutputPath", () => {
  it("returns true when output is empty", () => {
    expect(shouldAutofillOutputPath("", null)).toBe(true);
  });

  it("returns true when output matches previous autofill", () => {
    expect(shouldAutofillOutputPath("/out/test.7z", "/out/test.7z")).toBe(true);
  });

  it("returns false when user has customized output", () => {
    expect(shouldAutofillOutputPath("/out/custom.7z", "/out/test.7z")).toBe(
      false,
    );
  });
});

describe("resolveOutputArchiveAutofill", () => {
  it("autofills from inputs and format", () => {
    expect(
      resolveOutputArchiveAutofill("", null, ["/home/user/folder"], "zip"),
    ).toBe("/home/user/folder.zip");
  });

  it("updates when output matches previous autofill", () => {
    expect(
      resolveOutputArchiveAutofill(
        "/home/user/folder.7z",
        "/home/user/folder.7z",
        ["/home/user/folder"],
        "zip",
      ),
    ).toBe("/home/user/folder.zip");
  });

  it("returns null when user has customized output", () => {
    expect(
      resolveOutputArchiveAutofill(
        "/out/custom.7z",
        "/out/auto.7z",
        ["/home/user/folder"],
        "7z",
      ),
    ).toBeNull();
  });

  it("returns null for empty inputs", () => {
    expect(resolveOutputArchiveAutofill("", null, [], "7z")).toBeNull();
  });
});
