// Semver-style precedence for Zinnia versions such as "0.6.3-beta.10".
// Numeric prerelease identifiers compare numerically, release > its prereleases,
// and build metadata ("+...") is ignored.

const NUMERIC_IDENTIFIER = /^(0|[1-9]\d*)$/;

interface ParsedVersion {
  core: number[];
  prerelease: string[];
}

function parseVersion(version: string): ParsedVersion {
  const withoutBuild = version.split("+")[0];
  const dash = withoutBuild.indexOf("-");
  const corePart = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prePart = dash === -1 ? "" : withoutBuild.slice(dash + 1);
  const core = corePart.split(".").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  const prerelease = prePart ? prePart.split(".") : [];
  return { core, prerelease };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIdentifier(a: string, b: string): number {
  const aNumeric = NUMERIC_IDENTIFIER.test(a);
  const bNumeric = NUMERIC_IDENTIFIER.test(b);
  if (aNumeric && bNumeric) {
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return compareStrings(a, b);
  }
  // Numeric identifiers always rank below alphanumeric ones.
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return compareStrings(a, b);
}

function comparePrerelease(a: string[], b: string[]): number {
  // A release (no prerelease tag) ranks above any prerelease of the same core.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const diff = compareIdentifier(a[i], b[i]);
    if (diff !== 0) return diff;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** Returns >0 when `a` is newer than `b`, <0 when older, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}
