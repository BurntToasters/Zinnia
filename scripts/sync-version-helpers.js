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

export function updateWindowsResourceVersion(resource, version) {
  const numericVersion = windowsPackageVersionFromSemver(version).replaceAll(
    ".",
    ",",
  );
  let updated = updateWindowsResourceFlags(resource, version);
  const replacements = [
    [/^ FILEVERSION .+$/m, ` FILEVERSION ${numericVersion}`, "FILEVERSION"],
    [
      /^ PRODUCTVERSION .+$/m,
      ` PRODUCTVERSION ${numericVersion}`,
      "PRODUCTVERSION",
    ],
    [
      /^      VALUE "FileVersion", ".*\\0"$/m,
      `      VALUE "FileVersion", "${version}\\0"`,
      'VALUE "FileVersion"',
    ],
    [
      /^      VALUE "ProductVersion", ".*\\0"$/m,
      `      VALUE "ProductVersion", "${version}\\0"`,
      'VALUE "ProductVersion"',
    ],
  ];
  for (const [pattern, replacement, label] of replacements) {
    const matches = updated.match(
      new RegExp(pattern.source, `${pattern.flags}g`),
    );
    if (matches?.length !== 1) {
      throw new Error(
        `Windows resource ${label} field must appear exactly once; found ${matches?.length ?? 0}`,
      );
    }
    updated = updated.replace(pattern, replacement);
  }
  return updated;
}

/** Synchronize an isolated COM assembly identity with the package version. */
export function updateWindowsAssemblyIdentityVersion(manifest, version) {
  const packageVersion = windowsPackageVersionFromSemver(version);
  const pattern = /(<assemblyIdentity\b[^>]*\bversion=")[^"]+("\s*\/?>)/s;
  const matches = manifest.match(new RegExp(pattern.source, "gs"));
  if (matches?.length !== 1) {
    throw new Error(
      `Windows assembly identity version must appear exactly once; found ${matches?.length ?? 0}`,
    );
  }
  return manifest.replace(pattern, `$1${packageVersion}$2`);
}

const WINDOWS_SHELL_RESOURCES = Object.freeze({
  "windows/shell/out/zinnia_shell.dll": "zinnia_shell.dll",
  "windows/shell/out/zinnia_extract_shell.dll": "zinnia_extract_shell.dll",
  "windows/shell/out/ZinniaContextMenu.msix": "ZinniaContextMenu.msix",
  "windows/shell/out/ZinniaExtractContextMenu.msix":
    "ZinniaExtractContextMenu.msix",
  "../scripts/register-windows-context-menu.ps1":
    "register-windows-context-menu.ps1",
});

/** Keep Tauri's literal resource destinations aligned with the release version. */
export function updateWindowsShellResourceDestinations(config, version) {
  const resources = config?.bundle?.resources;
  if (!resources || Array.isArray(resources) || typeof resources !== "object") {
    throw new Error("Windows Tauri config is missing bundle.resources map");
  }

  const updatedResources = { ...resources };
  for (const [source, filename] of Object.entries(WINDOWS_SHELL_RESOURCES)) {
    if (!(source in resources)) {
      throw new Error(
        `Windows Tauri config is missing shell resource: ${source}`,
      );
    }
    updatedResources[source] = `shell-${version}/${filename}`;
  }

  return {
    ...config,
    bundle: {
      ...config.bundle,
      resources: updatedResources,
    },
  };
}

function parseReleaseSemver(version, target) {
  const match = version.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta)\.(0|[1-9]\d*))?$/,
  );
  if (!match) {
    throw new Error(
      `Version cannot be represented as a ${target} version: ${version}`,
    );
  }

  const [, major, minor, patch, stage, sequence] = match;
  const prereleaseNumber = stage ? Number(sequence) : null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    stage,
    prereleaseNumber,
  };
}

/**
 * Convert beta/stable SemVer into a monotonically ordered Windows/MSIX version.
 * Betas keep their sequence; stable reserves the maximum fourth component.
 */
export function windowsPackageVersionFromSemver(version) {
  const parsed = parseReleaseSemver(version, "Windows package");
  const core = [parsed.major, parsed.minor, parsed.patch];
  if (core.some((part) => part > 65535)) {
    throw new Error(`Windows version component exceeds 65535: ${version}`);
  }
  if (parsed.prereleaseNumber !== null && parsed.prereleaseNumber > 65534) {
    throw new Error(`Windows beta sequence must be 0-65534: ${version}`);
  }
  const build = parsed.prereleaseNumber ?? 65535;
  return [...core, build].join(".");
}

/**
 * Convert Zinnia's SemVer release version into Apple's numeric-only
 * CFBundleVersion. The last component reserves ranges for prerelease stages so
 * every beta/RC sorts below the corresponding stable release.
 */
export function macBundleVersionFromSemver(version) {
  const parsed = parseReleaseSemver(version, "macOS bundle");
  if (parsed.prereleaseNumber !== null && parsed.prereleaseNumber > 6998) {
    throw new Error(
      `macOS bundle prerelease sequence must be 0-6998: ${version}`,
    );
  }
  // 0-2999 stay reserved for future prerelease stages. Beta occupies
  // 3000-9998 and stable occupies 9999. The 10,000-wide patch block keeps
  // beta -> stable -> next-patch-beta strictly monotonic.
  let build = parsed.patch * 10_000;
  if (!parsed.stage) {
    build += 9999;
  } else {
    build += 3000 + parsed.prereleaseNumber;
  }

  return `${parsed.major}.${parsed.minor}.${build}`;
}

/** Apple's CFBundleShortVersionString accepts exactly three numeric fields. */
export function macMarketingVersionFromSemver(version) {
  const match = version.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(?:0|[1-9]\d*))?$/,
  );
  if (!match) {
    throw new Error(
      `Version cannot be represented as a macOS marketing version: ${version}`,
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** Replace exactly one string-valued plist key, failing closed on drift. */
export function updatePlistStringValue(plist, key, value) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(<key>${escapedKey}</key>\\s*<string>)[^<]*(</string>)`,
    "g",
  );
  const matches = plist.match(pattern);
  if (matches?.length !== 1) {
    throw new Error(
      `plist key ${key} must have exactly one string value; found ${matches?.length ?? 0}`,
    );
  }
  return plist.replace(pattern, `$1${value}$2`);
}

const CHANGELOG_INTRO_ANCHOR =
  "Zinnia! A cross platform 7Z gui frontend built on Tauri V2!\n\n";

/** Align CHANGELOG download URLs and section heading with package.json version. */
export function syncChangelogForVersion(changelog, version) {
  const tag = `v${version}`;
  const sectionHeading = `## Changes in \`${tag}:\``;

  const tableStart = changelog.indexOf("# ⬇️ Downloads");
  const tableEnd = changelog.indexOf("\n> macOS");
  if (tableStart === -1 || tableEnd === -1 || tableEnd <= tableStart) {
    throw new Error("CHANGELOG.md download table markers not found");
  }

  const before = changelog.slice(0, tableStart);
  const table = changelog.slice(tableStart, tableEnd);
  const after = changelog.slice(tableEnd);
  const syncedTable = table.replace(
    /\/releases\/download\/v[^/]+\//g,
    `/releases/download/${tag}/`,
  );
  let updated = before + syncedTable + after;

  if (!updated.includes(sectionHeading)) {
    if (!updated.includes(CHANGELOG_INTRO_ANCHOR)) {
      throw new Error("CHANGELOG.md intro anchor not found");
    }
    updated = updated.replace(
      CHANGELOG_INTRO_ANCHOR,
      `${CHANGELOG_INTRO_ANCHOR}${sectionHeading}\n\n- **Fix:** (add release notes)\n\n`,
    );
  }

  return updated;
}

export function syncNpmLockfileVersion(lockText, version) {
  let parsed;
  try {
    parsed = JSON.parse(lockText);
  } catch (error) {
    throw new Error(
      `package-lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("package-lock.json root must be an object");
  }
  if (!parsed.packages || typeof parsed.packages !== "object") {
    throw new Error("package-lock.json is missing packages");
  }
  if (!parsed.packages[""] || typeof parsed.packages[""] !== "object") {
    throw new Error('package-lock.json is missing packages[""]');
  }
  if (parsed.version === version && parsed.packages[""].version === version) {
    return lockText;
  }
  parsed.version = version;
  parsed.packages[""].version = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
