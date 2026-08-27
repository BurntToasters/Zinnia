"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STABLE_FORBIDDEN_ENV = [
  "SKIP_WIN_CODESIGN",
  "FORCE_UPLOAD",
  "SKIP_RELEASE_MIRROR",
  "ALLOW_ASSET_REPLACE",
];

function isExplicitTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function isStableReleaseVersion(version) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
    String(version || ""),
  );
}

function readPackageVersion(root = path.join(__dirname, "..")) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  return String(pkg.version || "").trim();
}

function assertStableReleaseOverridesAllowed(
  env = process.env,
  version = readPackageVersion(),
) {
  if (!isStableReleaseVersion(version)) return;
  const blocked = STABLE_FORBIDDEN_ENV.filter((name) =>
    isExplicitTruthy(env[name]),
  );
  if (blocked.length === 0) return;
  throw new Error(
    `Stable release ${version} refuses ${blocked.join(", ")}. Those overrides are beta recovery paths only.`,
  );
}

if (require.main === module) {
  try {
    assertStableReleaseOverridesAllowed();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  STABLE_FORBIDDEN_ENV,
  isExplicitTruthy,
  isStableReleaseVersion,
  readPackageVersion,
  assertStableReleaseOverridesAllowed,
};
