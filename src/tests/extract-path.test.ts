import { describe, it, expect } from "vitest";
import {
  deriveExtractDestinationPath,
  deriveExtractFolderName,
  resolveExtractDestinationAutofill,
  shouldAutofillExtractDestination,
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
