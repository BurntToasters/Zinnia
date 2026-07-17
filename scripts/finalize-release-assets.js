import fs from "node:fs";
import {
  RELEASE_DIR,
  finalizeReleaseAssets,
  getAfterPackLocation,
} from "./post-release-assets.js";

// Dedicated entry point: never gate on argv/path identity (Windows ESM footgun).
function banner(message) {
  // writeSync so the line is on the console even if Node later aborts in native fs.
  fs.writeSync(2, `[release:mirror] ${message}\n`);
}

banner("starting");
banner(`platform=${process.platform}; node=${process.version}`);
banner(`cwd=${process.cwd()}`);
banner(`releaseDir=${RELEASE_DIR}`);
banner(`AFTER_PACK_LOC=${JSON.stringify(getAfterPackLocation())}`);

try {
  const result = finalizeReleaseAssets({ logger: console });
  if (result.mirrored) {
    banner(
      `finished ok; copied=${result.copiedEntries}; dest=${result.destination}`,
    );
    process.exit(0);
  }

  banner(
    "finished with mirror skipped (AFTER_PACK_LOC empty/unset in this process)",
  );
  process.exit(0);
} catch (error) {
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);
  banner(`FAILED: ${message}`);
  process.exit(1);
}
