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

  it("preserves UNC and extended Windows path namespaces", () => {
    expect(
      deriveExtractDestinationPath("\\\\server\\share\\folder\\example.zip"),
    ).toBe("\\\\server\\share\\folder\\example");
    expect(
      deriveExtractDestinationPath(
        "\\\\?\\UNC\\server\\share\\folder\\example.7z",
      ),
    ).toBe("\\\\?\\UNC\\server\\share\\folder\\example");
    expect(
      deriveExtractDestinationPath(
        "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\folder\\example.zip",
      ),
    ).toBe(
      "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\folder\\example",
    );
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

  it("does not extract into . or .. when the archive stem is a parent marker", () => {
    expect(deriveExtractFolderName("..zip")).toBe("_extracted");
    expect(deriveExtractFolderName("...zip")).toBe("_extracted");
  });

  it("rewrites all-dot and trailing-dot dest stems that Win32 would collapse", () => {
    expect(deriveExtractFolderName("....zip")).toBe("_extracted");
    expect(deriveExtractFolderName("notes. .zip")).toBe("_extracted");
    expect(deriveExtractFolderName("notes..zip")).toBe("_extracted");
  });

  // Mirrors launch/open_path.rs::sanitize_extract_folder_name so the frontend
  // and backend derive the same destination on every platform.
  it("rewrites stems containing a colon (NTFS alternate data stream)", () => {
    expect(deriveExtractFolderName("notes:ads.zip")).toBe("_extracted");
    expect(deriveExtractFolderName("a:b.7z")).toBe("_extracted");
  });

  it("rewrites Win32 reserved device-name stems on every platform", () => {
    expect(deriveExtractFolderName("CON.zip")).toBe("_extracted");
    expect(deriveExtractFolderName("aux.tar.gz")).toBe("_extracted");
    expect(deriveExtractFolderName("com1.7z")).toBe("_extracted");
    expect(deriveExtractFolderName("LPT9.zip")).toBe("_extracted");
    expect(deriveExtractFolderName("COM¹.zip")).toBe("_extracted");
    expect(deriveExtractFolderName("conin$.zip")).toBe("_extracted");
    expect(deriveExtractFolderName("CON.txt.zip")).toBe("_extracted");
  });

  it("keeps near-miss names that are not reserved device names", () => {
    expect(deriveExtractFolderName("console.zip")).toBe("console");
    expect(deriveExtractFolderName("COM10.zip")).toBe("COM10");
    expect(deriveExtractFolderName("nullable.zip")).toBe("nullable");
    expect(deriveExtractFolderName("notes.v2.zip")).toBe("notes.v2");
  });

  // Failure modes, written before the implementation:
  // - a braced CLSID in a derived folder makes Windows shell parsing open a namespace view
  // - the CLSID check must apply on every platform, not only on Windows
  // - near-miss braces (wrong length, non-hex, no braces) stay ordinary names
  it("rewrites folder stems carrying a braced CLSID on every platform", () => {
    const guid = "{20D04FE0-3AEA-1069-A2D8-08002B30309D}";
    expect(deriveExtractFolderName(`Invoice.${guid}.zip`)).toBe("_extracted");
    expect(deriveExtractFolderName(`${guid}.zip`)).toBe("_extracted");
    expect(deriveExtractFolderName(`Invoice.${guid.toLowerCase()}.7z`)).toBe(
      "_extracted",
    );
  });

  it("keeps near-miss brace names that are not braced CLSIDs", () => {
    expect(deriveExtractFolderName("draft{1}.zip")).toBe("draft{1}");
    expect(deriveExtractFolderName("x{20D04FE0-3AEA-1069-A2D8-0800}.zip")).toBe(
      "x{20D04FE0-3AEA-1069-A2D8-0800}",
    );
    expect(
      deriveExtractFolderName("x{ZZD04FE0-3AEA-1069-A2D8-08002B30309D}.zip"),
    ).toBe("x{ZZD04FE0-3AEA-1069-A2D8-08002B30309D}");
    expect(
      deriveExtractFolderName("x20D04FE0-3AEA-1069-A2D8-08002B30309D.zip"),
    ).toBe("x20D04FE0-3AEA-1069-A2D8-08002B30309D");
  });
});

describe("shouldAutofillExtractDestination", () => {
  it("returns true when destination is empty", () => {
    expect(shouldAutofillExtractDestination("", null)).toBe(true);
  });

  it("preserves whitespace because it can be part of a real path", () => {
    expect(
      shouldAutofillExtractDestination(
        " /downloads/example ",
        "/downloads/example",
      ),
    ).toBe(false);
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

  it("derives outputs beside UNC and volume-GUID inputs", () => {
    expect(
      deriveOutputArchivePath(["\\\\server\\share\\folder\\readme.txt"], "zip"),
    ).toBe("\\\\server\\share\\folder\\readme.txt.zip");
    expect(
      deriveOutputArchivePath(
        [
          "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\folder\\readme.txt",
        ],
        "7z",
      ),
    ).toBe(
      "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\folder\\readme.txt.7z",
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

  it("maps stream formats to their conventional extensions", () => {
    expect(deriveOutputArchivePath(["/tmp/file"], "gzip")).toBe("/tmp/file.gz");
    expect(deriveOutputArchivePath(["/tmp/file"], "bzip2")).toBe(
      "/tmp/file.bz2",
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
