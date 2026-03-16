import assert from "node:assert/strict";

import {
  deriveExtractDestinationPath,
  deriveExtractFolderName,
  resolveExtractDestinationAutofill,
  shouldAutofillExtractDestination,
} from "../extract-path.ts";

export function runExtractPathTests() {
  assert.equal(deriveExtractDestinationPath("/downloads/example.zip"), "/downloads/example");
  assert.equal(deriveExtractDestinationPath("/downloads/example.tar.gz"), "/downloads/example");
  assert.equal(deriveExtractDestinationPath("/downloads/example.tgz"), "/downloads/example");
  assert.equal(deriveExtractDestinationPath("C:\\downloads\\example.7z"), "C:\\downloads\\example");
  assert.equal(deriveExtractDestinationPath("C:\\example.txz"), "C:\\example");
  assert.equal(
    deriveExtractDestinationPath("/downloads/example.custom"),
    "/downloads/example.custom_extracted"
  );
  assert.equal(deriveExtractDestinationPath("/downloads/example"), "/downloads/example_extracted");

  assert.equal(deriveExtractFolderName("archive.tar.bz2"), "archive");
  assert.equal(deriveExtractFolderName("archive.bin"), "archive.bin_extracted");

  assert.equal(shouldAutofillExtractDestination("", null), true);
  assert.equal(shouldAutofillExtractDestination(" /downloads/example ", "/downloads/example"), true);
  assert.equal(
    shouldAutofillExtractDestination("/downloads/custom-target", "/downloads/example"),
    false
  );

  assert.equal(
    resolveExtractDestinationAutofill("", null, "/downloads/new.zip"),
    "/downloads/new"
  );
  assert.equal(
    resolveExtractDestinationAutofill("/downloads/example", "/downloads/example", "/downloads/new.zip"),
    "/downloads/new"
  );
  assert.equal(
    resolveExtractDestinationAutofill("/downloads/custom", "/downloads/example", "/downloads/new.zip"),
    null
  );
}
