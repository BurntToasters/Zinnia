import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecutionOf } from "./direct-execution.mjs";

export const USER_AGENT = "zinnia-vendored-crates-watch";
export const CRATES_IO_API_URL = "https://crates.io/api/v1/crates";
export const FETCH_TIMEOUT_MS = 30000;
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const VENDOR_DIR = path.join("src-tauri", "vendor");
const CRATE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const ARRAY_TABLE_PATTERN = /^\[\[/u;
const TABLE_HEADER_PATTERN = /^\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/u;
const BASIC_STRING_PATTERN = /^"([^"\\]*)"\s*(?:#.*)?$/u;
const LITERAL_STRING_PATTERN = /^'([^']*)'\s*(?:#.*)?$/u;
const NUMERIC_IDENTIFIER_PATTERN = /^\d+$/u;

class FetchFailure extends Error {}

function literalValue(raw) {
  const basic = BASIC_STRING_PATTERN.exec(raw);
  if (basic) return basic[1];
  const literal = LITERAL_STRING_PATTERN.exec(raw);
  if (literal) return literal[1];
  return null;
}

function unquoteKey(key) {
  return key.replace(/^(["'])(.*)\1$/u, "$2");
}

function readPackageField(fields, name, source) {
  if (fields.has(name)) {
    const value = fields.get(name);
    if (value === null) {
      throw new Error(`${source}: [package] ${name} is not a literal string`);
    }
    return value;
  }
  if ([...fields.keys()].some((key) => key.startsWith(`${name}.`))) {
    throw new Error(`${source}: [package] ${name} is not a literal string`);
  }
  throw new Error(`${source}: [package] has no ${name}`);
}

export function parseCargoPackage(text, source = "Cargo.toml") {
  const fields = new Map();
  let table = null;
  for (const rawLine of String(text).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (ARRAY_TABLE_PATTERN.test(line)) {
      table = null;
      continue;
    }
    const header = TABLE_HEADER_PATTERN.exec(line);
    if (header) {
      table = header[1];
      continue;
    }
    if (table !== "package") continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = unquoteKey(line.slice(0, equals).trim());
    fields.set(key, literalValue(line.slice(equals + 1).trim()));
  }
  const name = readPackageField(fields, "name", source);
  if (!CRATE_NAME_PATTERN.test(name)) {
    throw new Error(`${source}: [package] name is not a valid crate name`);
  }
  const version = readPackageField(fields, "version", source);
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(
      `${source}: [package] version is not a valid semver version`,
    );
  }
  return { name, version };
}

function parseSemver(version) {
  const match = SEMVER_PATTERN.exec(String(version));
  if (!match) throw new Error(`invalid version: ${version}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrereleaseIdentifier(left, right) {
  const leftNumeric = NUMERIC_IDENTIFIER_PATTERN.test(left);
  const rightNumeric = NUMERIC_IDENTIFIER_PATTERN.test(right);
  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length)
      return left.length < right.length ? -1 : 1;
  } else if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function compareVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] < b.core[index] ? -1 : 1;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const order = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (order !== 0) return order;
  }
  return 0;
}

function describeTransportError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return `timeout after ${FETCH_TIMEOUT_MS} ms`;
  }
  return `network error (${error?.cause?.code ?? error?.message ?? "unknown"})`;
}

export async function fetchLatestStable(name, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${CRATES_IO_API_URL}/${name}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new FetchFailure(describeTransportError(error));
  }
  if (response.status === 404) return { found: false };
  if (!response.ok) throw new FetchFailure(`HTTP ${response.status}`);
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new FetchFailure(describeTransportError(error));
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FetchFailure("invalid JSON");
  }
  const latest = body?.crate?.max_stable_version;
  if (typeof latest !== "string") {
    throw new FetchFailure("no stable version in response");
  }
  if (!SEMVER_PATTERN.test(latest)) {
    throw new FetchFailure("invalid version in response");
  }
  return { found: true, latest };
}

export async function checkCrate(crate, fetchImpl = fetch) {
  const base = {
    crate: crate.name,
    vendored: crate.version,
    latest: "-",
    detail: "",
  };
  try {
    const result = await fetchLatestStable(crate.name, fetchImpl);
    if (!result.found) return { ...base, status: "not on crates.io" };
    return {
      ...base,
      latest: result.latest,
      status:
        compareVersions(crate.version, result.latest) < 0
          ? "behind"
          : "current",
    };
  } catch (error) {
    if (!(error instanceof FetchFailure)) throw error;
    return { ...base, status: "fetch failed", detail: error.message };
  }
}

function statusText(row) {
  return row.detail ? `${row.status} (${row.detail})` : row.status;
}

export function formatTable(rows) {
  const header = ["Crate", "Vendored", "Latest stable", "Status"];
  const body = rows.map((row) => [
    row.crate,
    row.vendored,
    row.latest,
    statusText(row),
  ]);
  const cells = [header, ...body];
  const widths = header.map((_, column) =>
    Math.max(...cells.map((line) => line[column].length)),
  );
  const render = (line) =>
    line
      .map((cell, index) =>
        index === line.length - 1 ? cell : cell.padEnd(widths[index]),
      )
      .join("  ")
      .trimEnd();
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [render(header), separator, ...body.map(render)].join("\n") + "\n";
}

export function collectVendoredCrates(root = REPO_ROOT) {
  const vendorDir = path.join(root, VENDOR_DIR);
  return fs
    .readdirSync(vendorDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((dirName) => {
      const manifestPath = path.join(vendorDir, dirName, "Cargo.toml");
      if (!fs.existsSync(manifestPath)) return [];
      const { name, version } = parseCargoPackage(
        fs.readFileSync(manifestPath, "utf8"),
        path.relative(root, manifestPath),
      );
      return [{ name, version, manifestPath }];
    });
}

export async function runReport({
  root = REPO_ROOT,
  fetchImpl = fetch,
  write = (text) => process.stdout.write(text),
} = {}) {
  const crates = collectVendoredCrates(root);
  const rows = [];
  for (const crate of crates) {
    rows.push(await checkCrate(crate, fetchImpl));
  }
  if (crates.length === 0) {
    write("No vendored crates found under src-tauri/vendor.\n");
  } else {
    write(formatTable(rows));
  }
  write("Report only: exit status is 0 unless this script fails.\n");
  return rows;
}

if (isDirectExecutionOf(import.meta.url)) {
  runReport().catch((error) => {
    console.error(`vendored-crates-watch: ${error.message}`);
    process.exitCode = 1;
  });
}
