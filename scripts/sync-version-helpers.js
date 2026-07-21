/**
 * Keep the root crate's version in Cargo.lock aligned with Cargo.toml.
 * Cargo rewrites this on the next build; leaving it stale dirties the tree
 * mid-release and breaks Flatpak's clean `git archive` + `--locked` build.
 */
export function updateCargoLockPackageVersion(lockfile, packageName, version) {
  const pattern = new RegExp(
    `(\\[\\[package\\]\\]\\r?\\nname = "${packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\r?\\nversion = )"[^"]*"`,
  );
  if (!pattern.test(lockfile)) {
    throw new Error(
      `Cargo.lock is missing [[package]] name = "${packageName}"`,
    );
  }
  return lockfile.replace(pattern, `$1"${version}"`);
}

export function updateWindowsResourceFlags(resource, version) {
  const prerelease = version.includes("-");
  const debugFlags = prerelease
    ? "VS_FF_DEBUG | VS_FF_PRERELEASE"
    : "VS_FF_DEBUG";
  const releaseFlags = prerelease ? "VS_FF_PRERELEASE" : "0";
  const flagsBlock = [
    "#ifdef _DEBUG",
    ` FILEFLAGS ${debugFlags}`,
    "#else",
    ` FILEFLAGS ${releaseFlags}`,
    "#endif",
  ].join("\n");
  const pattern =
    /#ifdef _DEBUG\r?\n FILEFLAGS [^\r\n]+\r?\n#else\r?\n FILEFLAGS [^\r\n]+\r?\n#endif/;

  if (!pattern.test(resource)) {
    throw new Error("Windows resource FILEFLAGS block was not found");
  }

  return resource.replace(pattern, flagsBlock);
}

/**
 * Convert Zinnia's SemVer release version into Apple's numeric-only
 * CFBundleVersion. The last component reserves ranges for prerelease stages so
 * every beta/RC sorts below the corresponding stable release.
 */
export function macBundleVersionFromSemver(version) {
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/,
  );
  if (!match) {
    throw new Error(
      `Version cannot be represented as a macOS bundle version: ${version}`,
    );
  }

  const [, major, minor, patch, stage, sequence] = match;
  let build = Number(patch) * 100;
  if (!stage) {
    build += 99;
  } else {
    const stageBase = { alpha: 0, beta: 30, rc: 60 }[stage];
    const prereleaseNumber = Number(sequence);
    if (prereleaseNumber > 29) {
      throw new Error(`macOS prerelease sequence must be 0-29: ${version}`);
    }
    build += stageBase + prereleaseNumber;
  }

  return `${major}.${minor}.${build}`;
}
