import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "../..");

export const WARMUP_ITERATIONS = 1;
export const MEASURED_ITERATIONS = 5;
export const TARGET_LIMITS = Object.freeze({
  bulk: 1.25,
  small: 1.5,
});
export const TREND_THRESHOLD = 0.1;
export const NOISE_THRESHOLD = 0.1;
export const BULK_BYTES = 8 * 1024 * 1024;
export const SMALL_FILE_COUNT = 256;
export const SMALL_FILE_BYTES = 4096;

export const FIXTURE_SCALES = Object.freeze({
  smoke: Object.freeze({
    name: "smoke",
    bulkBytes: BULK_BYTES,
    smallFileCount: SMALL_FILE_COUNT,
    smallFileBytes: SMALL_FILE_BYTES,
    description: "8 MiB bulk file and 256 4 KiB files",
  }),
  release: Object.freeze({
    name: "release",
    bulkBytes: 64 * 1024 * 1024,
    smallFileCount: 2048,
    smallFileBytes: 8192,
    description: "64 MiB bulk file and 2048 8 KiB files",
  }),
});

export const OPERATIONS = Object.freeze([
  "browse",
  "test",
  "extract",
  "create",
  "replace",
  "update",
  "selective-extract",
  "conversion",
  "batch",
]);

export const WORKLOADS = Object.freeze({
  bulk: Object.freeze({
    name: "bulk",
    description: "one deterministic 8 MiB file",
  }),
  small: Object.freeze({
    name: "small",
    description: "256 deterministic 4 KiB files",
  }),
});

export const FORMATS = Object.freeze({
  zip: Object.freeze({
    extension: "zip",
    switches: ["-tzip", "-mx=5", "-mcu=on"],
    directory: true,
    compatibility: "measured",
  }),
  "7z": Object.freeze({
    extension: "7z",
    switches: ["-t7z", "-mx=5", "-m0=lzma2"],
    directory: true,
    compatibility: "measured",
  }),
  tar: Object.freeze({
    extension: "tar",
    switches: ["-ttar", "-mx=0"],
    directory: true,
    compatibility: "measured",
  }),
  gzip: Object.freeze({
    extension: "gz",
    switches: ["-tgzip", "-mx=5"],
    directory: false,
    compatibility: "single-file stream; bulk workload only",
  }),
  bzip2: Object.freeze({
    extension: "bz2",
    switches: ["-tbzip2", "-mx=5"],
    directory: false,
    compatibility: "single-file stream; bulk workload only",
  }),
  xz: Object.freeze({
    extension: "xz",
    switches: ["-txz", "-mx=5"],
    directory: false,
    compatibility: "single-file stream; bulk workload only",
  }),
});

export const COMPATIBILITY_CASES = Object.freeze([
  Object.freeze({
    name: "rar",
    status: "measured-when-enabled",
    primary: false,
    note: "Reads the tracked deterministic RAR4 fixture; RAR remains outside primary targets.",
  }),
  Object.freeze({
    name: "split",
    status: "measured-when-enabled",
    primary: false,
    note: "Generates a deterministic 7z split-volume family for each host; split rows stay outside primary targets.",
  }),
  Object.freeze({
    name: "encrypted",
    status: "measured-when-enabled",
    primary: false,
    note: "Reads the tracked password-bearing fixture with a fixed private test password; password material is never reported.",
  }),
  Object.freeze({
    name: "link-bearing",
    status: "host-gated",
    primary: false,
    note: "Generates a TAR with 7-Zip hard-link metadata; hosts that cannot create or preserve links report not-available.",
  }),
  Object.freeze({
    name: "unsupported-filesystem",
    status: "not-available",
    primary: false,
    note: "Filesystem features unavailable on this runner are reported as not-available, never measured with a substitute.",
  }),
  Object.freeze({
    name: "custom-acl",
    status: "not-available",
    primary: false,
    note: "Custom ACL timing requires a runner with matching ACL support; unsupported ACLs are not faked.",
  }),
]);

function parseList(value, label) {
  const values = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error(`${label} must not be empty.`);
  return values;
}

function parseOperationList(value, label) {
  const values = parseList(value, label);
  for (const operation of values) {
    if (!OPERATIONS.includes(operation)) {
      throw new Error(`Unsupported ${label} operation: ${operation}`);
    }
  }
  return values;
}

export function parseArgs(argv) {
  const options = {
    outputDir:
      process.env.ZINNIA_BENCH_REPORT_DIR ||
      join(tmpdir(), "zinnia-archive-io-report"),
    formats: Object.keys(FORMATS),
    workloads: Object.keys(WORKLOADS),
    operations: OPERATIONS.slice(),
    operationFormats: ["zip"],
    operationWorkloads: ["bulk"],
    scale: process.env.ZINNIA_BENCH_SCALE || "smoke",
    zinniaCommand: process.env.ZINNIA_BENCH_COMMAND || null,
    candidateRevision:
      process.env.ZINNIA_BENCH_CANDIDATE_REVISION ||
      process.env.ZINNIA_BENCH_CANDIDATE_REF ||
      process.env.GITHUB_SHA ||
      null,
    baseRevision:
      process.env.ZINNIA_BENCH_BASE_REVISION ||
      process.env.ZINNIA_BENCH_BASELINE_REF ||
      process.env.ZINNIA_BENCH_BASE_REF ||
      process.env.GITHUB_BASE_SHA ||
      null,
    candidateRef: process.env.ZINNIA_BENCH_CANDIDATE_REF || null,
    baseRef:
      process.env.ZINNIA_BENCH_BASE_REF ||
      process.env.ZINNIA_BENCH_BASELINE_REF ||
      null,
    baselineReport: process.env.ZINNIA_BENCH_BASELINE_REPORT || null,
    compatibility: process.env.ZINNIA_BENCH_COMPATIBILITY === "1",
    requireZinnia:
      process.env.ZINNIA_BENCH_REQUIRE_ZINNIA === "1" ||
      process.env.ZINNIA_BENCH_REQUIRE_CANDIDATE === "1",
    keepWorkdir: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value.`);
      return argv[index];
    };
    if (arg === "--output-dir") options.outputDir = next();
    else if (arg === "--formats")
      options.formats = parseList(next(), "--formats");
    else if (arg === "--workloads") {
      options.workloads = parseList(next(), "--workloads");
    } else if (arg === "--operations") {
      options.operations = parseOperationList(next(), "--operations");
    } else if (arg === "--operation-formats") {
      options.operationFormats = parseList(next(), "--operation-formats");
    } else if (arg === "--operation-workloads") {
      options.operationWorkloads = parseList(next(), "--operation-workloads");
    } else if (arg === "--scale") options.scale = next();
    else if (arg === "--zinnia-command") options.zinniaCommand = next();
    else if (arg === "--candidate-revision") options.candidateRevision = next();
    else if (arg === "--base-revision") options.baseRevision = next();
    else if (arg === "--candidate-ref") options.candidateRef = next();
    else if (arg === "--base-ref") options.baseRef = next();
    else if (arg === "--baseline-report") options.baselineReport = next();
    else if (arg === "--compatibility") options.compatibility = true;
    else if (arg === "--require-zinnia" || arg === "--require-candidate")
      options.requireZinnia = true;
    else if (arg === "--allow-missing-candidate") options.requireZinnia = false;
    else if (arg === "--keep-workdir") options.keepWorkdir = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  for (const format of options.formats) {
    if (!FORMATS[format]) throw new Error(`Unsupported format: ${format}`);
  }
  for (const workload of options.workloads) {
    if (!WORKLOADS[workload])
      throw new Error(`Unsupported workload: ${workload}`);
  }
  for (const format of options.operationFormats) {
    if (!FORMATS[format])
      throw new Error(`Unsupported operation format: ${format}`);
  }
  for (const workload of options.operationWorkloads) {
    if (!WORKLOADS[workload])
      throw new Error(`Unsupported operation workload: ${workload}`);
  }
  if (!FIXTURE_SCALES[options.scale]) {
    throw new Error(
      `Unsupported fixture scale: ${options.scale} (choose smoke or release).`,
    );
  }
  if (options.zinniaCommand)
    parseOperationCommandTemplates(options.zinniaCommand);
  return options;
}

export function parseCommandTemplate(commandJson) {
  let command;
  try {
    command = JSON.parse(commandJson);
  } catch (error) {
    throw new Error(
      `ZINNIA_BENCH_COMMAND must be a JSON argv array: ${error.message}`,
    );
  }
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== "string")
  ) {
    throw new Error(
      "ZINNIA_BENCH_COMMAND must be a non-empty JSON array of strings.",
    );
  }
  return command;
}

function validateCommandTemplate(command, label) {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== "string")
  ) {
    throw new Error(`${label} must be a non-empty JSON array of strings.`);
  }
  return command;
}

/**
 * Parse an operation-aware adapter. A legacy argv array remains valid as an
 * extract-only adapter; omitted operation keys stay unavailable and are never
 * replaced with synthetic timings.
 */
export function parseOperationCommandTemplates(commandJson) {
  let parsed;
  try {
    parsed = JSON.parse(commandJson);
  } catch (error) {
    throw new Error(
      `ZINNIA_BENCH_COMMAND must be a JSON argv array or operation map: ${error.message}`,
    );
  }
  if (Array.isArray(parsed)) {
    return { extract: validateCommandTemplate(parsed, "ZINNIA_BENCH_COMMAND") };
  }
  if (
    parsed == null ||
    typeof parsed !== "object" ||
    Object.keys(parsed).length === 0
  ) {
    throw new Error(
      "ZINNIA_BENCH_COMMAND must be a non-empty operation map or argv array.",
    );
  }
  const templates = {};
  for (const [operation, command] of Object.entries(parsed)) {
    if (!OPERATIONS.includes(operation)) {
      throw new Error(`Unsupported Zinnia adapter operation: ${operation}`);
    }
    templates[operation] = validateCommandTemplate(
      command,
      `ZINNIA_BENCH_COMMAND.${operation}`,
    );
  }
  return templates;
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .toSorted((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Median absolute deviation. Non-finite samples are ignored, like median().
 * Keep this unscaled: callers need the same unit as their samples.
 */
export function medianAbsoluteDeviation(values) {
  const finite = Array.isArray(values)
    ? values.filter((value) => Number.isFinite(value))
    : [];
  const center = median(finite);
  if (center == null) return null;
  return median(finite.map((value) => Math.abs(value - center)));
}

export function relativeMedianAbsoluteDeviation(values) {
  const center = median(values);
  const deviation = medianAbsoluteDeviation(values);
  if (center == null || deviation == null || center <= 0) return null;
  return deviation / center;
}

function finiteNumbers(values) {
  return Array.isArray(values)
    ? values.filter((value) => Number.isFinite(value))
    : [];
}

export function ratioSamples(zinniaValues, directValues) {
  if (!Array.isArray(zinniaValues) || !Array.isArray(directValues)) return [];
  const count = Math.min(zinniaValues.length, directValues.length);
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const zinnia = zinniaValues[index];
    const direct = directValues[index];
    if (Number.isFinite(zinnia) && Number.isFinite(direct) && direct > 0) {
      samples.push(zinnia / direct);
    }
  }
  return samples;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeDeterministicFile(path, size, seed) {
  const chunk = Buffer.allocUnsafe(Math.min(size, 1024 * 1024));
  let state = seed >>> 0;
  let written = 0;
  while (written < size) {
    const count = Math.min(chunk.length, size - written);
    for (let index = 0; index < count; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      chunk[index] = state & 0xff;
    }
    writeFileSync(path, chunk.subarray(0, count), {
      flag: written === 0 ? "w" : "a",
    });
    written += count;
  }
}

function collectFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Fixture unexpectedly contains a symbolic link: ${current}`,
      );
    }
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(current))
        pending.push(join(current, entry));
      continue;
    }
    if (!metadata.isFile())
      throw new Error(`Fixture contains unsupported entry: ${current}`);
    files.push(current);
  }
  return files.toSorted();
}

function fixtureManifest(fixtureRoot) {
  return collectFiles(fixtureRoot).map((path) => ({
    path: relative(fixtureRoot, path).split("\\").join("/"),
    bytes: statSync(path).size,
    sha256: sha256File(path),
  }));
}

function setDeterministicTimes(
  root,
  fixedTime = new Date("2020-01-01T00:00:00.000Z"),
) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    utimesSync(current, fixedTime, fixedTime);
    if (!lstatSync(current).isDirectory()) continue;
    for (const entry of readdirSync(current))
      pending.push(join(current, entry));
  }
}

function createFixture(root, workload, scaleName = "smoke") {
  const scale = FIXTURE_SCALES[scaleName];
  if (!scale) throw new Error(`Unknown fixture scale: ${scaleName}`);
  const fixtureRoot = join(root, "fixtures", workload);
  const payloadRoot = join(fixtureRoot, "payload");
  mkdirSync(payloadRoot, { recursive: true });
  if (workload === "bulk") {
    writeDeterministicFile(
      join(payloadRoot, "bulk.bin"),
      scale.bulkBytes,
      0x12345678,
    );
  } else {
    const smallRoot = join(payloadRoot, "small");
    mkdirSync(smallRoot, { recursive: true });
    for (let index = 0; index < scale.smallFileCount; index += 1) {
      writeDeterministicFile(
        join(smallRoot, `file-${String(index).padStart(4, "0")}.bin`),
        scale.smallFileBytes,
        (0xabcdef01 + index * 0x10203) >>> 0,
      );
    }
  }
  setDeterministicTimes(fixtureRoot);
  return {
    root: fixtureRoot,
    source: workload === "bulk" ? "payload/bulk.bin" : "payload",
    manifest: fixtureManifest(fixtureRoot),
  };
}

const COMPATIBILITY_PASSWORD = "zinnia-test";

function createCompatibilityFixture(root, name) {
  const fixtureRoot = join(root, "compatibility", name);
  mkdirSync(fixtureRoot, { recursive: true });
  if (name === "split") {
    writeDeterministicFile(join(fixtureRoot, "blob.bin"), 96 * 1024, 0x51f15e7);
    setDeterministicTimes(fixtureRoot);
    return {
      root: fixtureRoot,
      source: "blob.bin",
      manifest: fixtureManifest(fixtureRoot),
    };
  }
  if (name === "link-bearing") {
    writeFileSync(join(fixtureRoot, "real.txt"), "link-bearing fixture\n");
    linkSync(join(fixtureRoot, "real.txt"), join(fixtureRoot, "hard.txt"));
    setDeterministicTimes(fixtureRoot);
    return {
      root: fixtureRoot,
      source: ".",
      manifest: fixtureManifest(fixtureRoot),
    };
  }
  copyFileSync(
    join(REPO_ROOT, "zips", "hello.txt"),
    join(fixtureRoot, "hello.txt"),
  );
  setDeterministicTimes(fixtureRoot);
  return {
    root: fixtureRoot,
    source: "hello.txt",
    manifest: fixtureManifest(fixtureRoot),
  };
}

function createCompatibilityArchive(name, fixture, sidecar, archiveRoot) {
  if (name === "rar") {
    const archivePath = join(archiveRoot, "compatibility.rar");
    copyFileSync(join(REPO_ROOT, "zips", "hello.rar"), archivePath);
    return { archivePath, format: "rar", password: "" };
  }
  if (name === "encrypted") {
    const archivePath = join(archiveRoot, "compatibility-encrypted.7z");
    copyFileSync(join(REPO_ROOT, "zips", "encrypted.7z"), archivePath);
    return { archivePath, format: "7z", password: COMPATIBILITY_PASSWORD };
  }
  if (name === "split") {
    const archivePath = join(archiveRoot, "compatibility-split.7z");
    const result = runProcess(
      sidecar,
      ["a", "-t7z", "-mx=0", "-v32k", archivePath, "--", fixture.source],
      { cwd: fixture.root },
    );
    assertSuccess(result, "Create split compatibility fixture");
    return {
      archivePath: `${archivePath}.001`,
      format: "7z",
      password: "",
    };
  }
  if (name === "link-bearing") {
    const archivePath = join(archiveRoot, "compatibility-links.tar");
    const result = runProcess(
      sidecar,
      ["a", "-ttar", "-mx=0", "-snh", archivePath, "--", "."],
      { cwd: fixture.root },
    );
    assertSuccess(result, "Create link-bearing compatibility fixture");
    const listing = runProcess(sidecar, ["l", "-slt", "--", archivePath]);
    assertSuccess(listing, "Inspect link-bearing compatibility fixture");
    if (!hasArchiveLinkMetadata(listing.stdout)) {
      throw new Error(
        "Generated link-bearing compatibility fixture has no non-empty Hard Link or Symbolic Link metadata.",
      );
    }
    return { archivePath, format: "tar", password: "" };
  }
  throw new Error(`Unsupported compatibility archive: ${name}`);
}

function hostSidecarPath() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const suffix =
    process.platform === "win32"
      ? `pc-windows-msvc.exe`
      : process.platform === "darwin"
        ? `apple-darwin`
        : `unknown-linux-gnu`;
  const candidates = [
    join(REPO_ROOT, "src-tauri", "binaries", `7z-${arch}-${suffix}`),
  ];
  if (process.platform === "darwin") {
    candidates.push(
      join(REPO_ROOT, "src-tauri", "binaries", "7z-universal-apple-darwin"),
    );
  }
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error(
      "Bundled 7-Zip sidecar not found. Run `npm run prepare:7z` before benchmarking.",
    );
  }
  return path;
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
  });
  const stdout = result.stdout?.toString("utf8") || "";
  const stderr = result.stderr?.toString("utf8") || "";
  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  return {
    code: result.status ?? 1,
    stdout,
    stderr,
    signal: result.signal,
  };
}

function directCreateArgs(format, archivePath, source) {
  return ["a", ...FORMATS[format].switches, archivePath, "--", source];
}

function directExtractArgs(archivePath, outputPath, password = "") {
  return [
    "x",
    "-y",
    ...(password ? [`-p${password}`] : []),
    `-o${outputPath}`,
    "--",
    archivePath,
  ];
}

function outputManifest(format, fixture) {
  if (FORMATS[format].directory) return fixture.manifest;
  const source = fixture.manifest.find(
    (entry) => entry.path === "payload/bulk.bin",
  );
  if (!source) throw new Error("Bulk stream fixture file is missing.");
  return [
    {
      ...source,
      // 7-Zip strips stream suffixes during extraction. The exact stem varies
      // by codec, so map expected output names to the sidecar's documented
      // convention instead of weakening content verification.
      path: format === "gzip" ? "bulk.bin" : "bulk",
    },
  ];
}

function assertSuccess(result, context) {
  if (result.code !== 0) {
    throw new Error(
      `${context} failed with code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }
}

export function verifyBrowseListing(stdout, expectedManifest) {
  const text = String(stdout || "").replaceAll("\\", "/");
  if (!text) return { ok: false, reason: "archive listing is empty" };
  for (const entry of expectedManifest) {
    const path = entry.path.replaceAll("\\", "/");
    if (
      !text.includes(`Path = ${path}`) &&
      !text.split(/\r?\n/).some((line) => line.trim() === path)
    ) {
      return { ok: false, reason: `archive listing misses ${path}` };
    }
  }
  return { ok: true, reason: null };
}

/**
 * Return true only when a 7-Zip -slt listing contains an actual link target.
 * An archive containing two ordinary files must not enter the link-bearing
 * compatibility timing path.
 */
export function hasArchiveLinkMetadata(stdout) {
  return /^(?:Hard|Symbolic) Link =\s*\S.*$/m.test(String(stdout || ""));
}

export function verifyOutputTree(outputRoot, expectedManifest) {
  if (!existsSync(outputRoot))
    return { ok: false, reason: "output directory missing" };
  const actual = fixtureManifest(outputRoot);
  if (actual.length !== expectedManifest.length) {
    return {
      ok: false,
      reason: `expected ${expectedManifest.length} files, found ${actual.length}`,
    };
  }
  const expectedByPath = new Map(
    expectedManifest.map((entry) => [entry.path, entry]),
  );
  for (const entry of actual) {
    const expected = expectedByPath.get(entry.path);
    if (!expected)
      return { ok: false, reason: `unexpected output entry ${entry.path}` };
    if (expected.bytes !== entry.bytes || expected.sha256 !== entry.sha256) {
      return { ok: false, reason: `content mismatch for ${entry.path}` };
    }
  }
  return { ok: true, reason: null };
}

function redactedCommand(command) {
  return (
    command?.map((part, index) => {
      if (index === 0) return basename(part);
      if (/(?:password|passphrase|secret)/i.test(part) || /^-p.+/i.test(part)) {
        return "<redacted>";
      }
      if (
        isPathLike(part) ||
        /(?:^|=|-o)(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(part)
      ) {
        return "<path>";
      }
      return part;
    }) ?? null
  );
}

function isPathLike(value) {
  return (
    typeof value === "string" &&
    !value.includes("{") &&
    (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value) ||
      /(?:^|[\\/])(?:tmp|temp|fixtures|archives|output|payload)(?:[\\/]|$)/i.test(
        value,
      ))
  );
}

export function redactText(value, paths = []) {
  let text = value == null ? "" : String(value);
  const knownPaths = paths
    .filter((path) => typeof path === "string" && path.length > 0)
    .toSorted((left, right) => right.length - left.length);
  for (const path of knownPaths) text = text.split(path).join("<path>");
  // Redact common absolute path spellings left by child processes. Keep
  // command placeholders and relative archive member names readable.
  return text
    .replace(/\b[A-Za-z]:[\\/][^\r\n\t ]+/g, "<path>")
    .replace(/\\\\[^\r\n\t ]+/g, "<path>")
    .replace(/\/(?:tmp|var|private|home|Users|runner)[^\r\n\t ]*/g, "<path>")
    .replace(
      /((?:password|passphrase|secret))(?:\s*[:=]\s*)[^\s,;]+/gi,
      (_match, label) => `${label}=<redacted>`,
    )
    .replace(/(?:^|\s)-p[^\s]+/gi, (match) =>
      match.startsWith(" ") ? " <redacted>" : "<redacted>",
    );
}

function safeError(error, paths = []) {
  return redactText(
    error instanceof Error ? error.message : String(error),
    paths,
  );
}

function redactedCommandMap(templates) {
  if (!templates) return null;
  return Object.fromEntries(
    Object.entries(templates).map(([operation, command]) => [
      operation,
      redactedCommand(command),
    ]),
  );
}

function replaceTokens(value, context) {
  return value.replaceAll(
    /\{(archive|input|output|target|format|targetFormat|workload|root|operation|selection|source)\}/g,
    (_match, token) => {
      return context[token] ?? "";
    },
  );
}

function zinniaCommandFor(commandJson, context) {
  const template = Array.isArray(commandJson)
    ? commandJson
    : parseCommandTemplate(commandJson);
  return template.map((part) => replaceTokens(part, context));
}

function commandTemplateFor(template, context) {
  return template.map((part) => replaceTokens(part, context));
}

function runTimed(label, command, args, options) {
  const started = performance.now();
  const result = runProcess(command, args, options);
  const durationMs = performance.now() - started;
  if (result.code !== 0) {
    throw new Error(
      `${label} failed with code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }
  return { durationMs, code: result.code };
}

function summarizeBackendRuns(runs) {
  const warmupMs = runs.warmup.map((run) => run.durationMs);
  const measuredMs = runs.measured.map((run) => run.durationMs);
  return {
    warmupMs,
    measuredMs,
    medianMs: median(measuredMs),
    medianAbsoluteDeviationMs: medianAbsoluteDeviation(measuredMs),
    relativeMedianAbsoluteDeviation:
      relativeMedianAbsoluteDeviation(measuredMs),
    madMs: medianAbsoluteDeviation(measuredMs),
    relativeMad: relativeMedianAbsoluteDeviation(measuredMs),
    verified: runs.verified,
    error: runs.error,
  };
}

function backendSummary(runs) {
  return summarizeBackendRuns(runs);
}

function backendInvocation({
  backend,
  archivePath,
  outputRoot,
  fixture,
  format,
  workload,
  command,
  password = "",
}) {
  const context = {
    archive: archivePath,
    input: archivePath,
    output: outputRoot,
    target: outputRoot,
    format,
    workload,
    root: fixture.root,
    operation: "extract",
    selection: "",
    source: operationSourcePath(fixture),
  };
  return backend === "7z"
    ? {
        command: command,
        args: directExtractArgs(archivePath, outputRoot, password),
      }
    : (() => {
        const rendered = zinniaCommandFor(command, context);
        return { command: rendered[0], args: rendered.slice(1) };
      })();
}

function runBackendIteration({
  backend,
  archivePath,
  outputRoot,
  fixture,
  expectedManifest,
  format,
  workload,
  command,
  password = "",
  iteration,
  warmup,
}) {
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const argv = backendInvocation({
    backend,
    archivePath,
    outputRoot,
    fixture,
    format,
    workload,
    command,
    password,
  });
  const run = runTimed(
    `${backend} ${workload}/${format} ${warmup ? "warm-up" : `iteration ${iteration + 1}`}`,
    argv.command,
    argv.args,
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        ZINNIA_BENCH_ARCHIVE: archivePath,
        ZINNIA_BENCH_OUTPUT: outputRoot,
        ZINNIA_BENCH_FORMAT: format,
        ZINNIA_BENCH_WORKLOAD: workload,
      },
    },
  );
  const verification = verifyOutputTree(outputRoot, expectedManifest);
  if (!verification.ok) {
    throw new Error(
      `${backend} ${warmup ? "warm-up" : "measured"} output: ${verification.reason}`,
    );
  }
  return run;
}

function createBackendResult() {
  return { warmup: [], measured: [], verified: true, error: null };
}

function recordBackendFailure(result, error, redactionPaths = []) {
  result.verified = false;
  result.error ??= safeError(error, redactionPaths);
}

function runBackend({
  backend,
  archivePath,
  outputRoot,
  fixture,
  expectedManifest,
  format,
  workload,
  command,
  password = "",
  warmup = true,
  measured = true,
}) {
  const result = createBackendResult();
  if (warmup) {
    try {
      result.warmup.push(
        runBackendIteration({
          backend,
          archivePath,
          outputRoot,
          fixture,
          expectedManifest,
          format,
          workload,
          command,
          password,
          iteration: 0,
          warmup: true,
        }),
      );
    } catch (error) {
      recordBackendFailure(result, error);
    }
  }
  if (measured && result.error == null) {
    for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
      try {
        result.measured.push(
          runBackendIteration({
            backend,
            archivePath,
            outputRoot,
            fixture,
            expectedManifest,
            format,
            workload,
            command,
            password,
            iteration: index,
            warmup: false,
          }),
        );
      } catch (error) {
        recordBackendFailure(result, error);
        break;
      }
    }
  }
  return backendSummary(result);
}

function runAlternatingBackends({
  archivePath,
  fixture,
  expectedManifest,
  format,
  workload,
  sidecar,
  zinniaCommand,
  runRoot,
}) {
  const configurations = {
    "7z": {
      outputRoot: join(runRoot, "7z"),
      command: sidecar,
    },
    zinnia: {
      outputRoot: join(runRoot, "zinnia"),
      command: zinniaCommand,
    },
  };
  const results = {
    "7z": createBackendResult(),
    zinnia: createBackendResult(),
  };
  const backends = ["7z", "zinnia"];
  for (const backend of backends) {
    try {
      results[backend].warmup.push(
        runBackendIteration({
          backend,
          archivePath,
          outputRoot: configurations[backend].outputRoot,
          fixture,
          expectedManifest,
          format,
          workload,
          command: configurations[backend].command,
          iteration: 0,
          warmup: true,
        }),
      );
    } catch (error) {
      recordBackendFailure(results[backend], error);
    }
  }
  for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
    const order = index % 2 === 0 ? backends : [...backends].reverse();
    for (const backend of order) {
      if (results[backend].error != null) continue;
      try {
        results[backend].measured.push(
          runBackendIteration({
            backend,
            archivePath,
            outputRoot: configurations[backend].outputRoot,
            fixture,
            expectedManifest,
            format,
            workload,
            command: configurations[backend].command,
            iteration: index,
            warmup: false,
          }),
        );
      } catch (error) {
        recordBackendFailure(results[backend], error);
      }
    }
  }
  return {
    direct: backendSummary(results["7z"]),
    zinnia: backendSummary(results.zinnia),
  };
}

function applicable(format, workload) {
  return FORMATS[format].directory || workload === "bulk";
}

function operationApplicable(operation, format, workload) {
  if (!applicable(format, workload)) return false;
  // Stream formats remain covered by the extraction matrix. The operation
  // suite requires a directory archive so create/update/selective/conversion
  // have stable member semantics across bundled 7-Zip builds.
  if (
    !FORMATS[format].directory &&
    !["browse", "test", "extract"].includes(operation)
  ) {
    return false;
  }
  return true;
}

function createArchive(
  sidecar,
  fixture,
  format,
  workload,
  archiveRoot,
  archiveName = workload,
) {
  const archivePath = join(
    archiveRoot,
    `${archiveName}.${FORMATS[format].extension}`,
  );
  const source = FORMATS[format].directory ? "payload" : "payload/bulk.bin";
  const result = runProcess(
    sidecar,
    directCreateArgs(format, archivePath, source),
    {
      cwd: fixture.root,
    },
  );
  assertSuccess(result, `Create ${format} ${workload} fixture`);
  assertSuccess(
    runProcess(sidecar, ["t", "--", archivePath], { cwd: fixture.root }),
    `Test ${format} ${workload} fixture`,
  );
  return archivePath;
}

function caseReport({
  fixture,
  archivePath,
  format,
  workload,
  sidecar,
  zinniaCommand,
  runRoot,
}) {
  const expectedManifest = outputManifest(format, fixture);
  if (zinniaCommand) {
    const alternating = runAlternatingBackends({
      archivePath,
      fixture,
      expectedManifest,
      format,
      workload,
      sidecar,
      zinniaCommand,
      runRoot,
    });
    return {
      workload,
      format,
      compatibility: FORMATS[format].compatibility,
      archiveBytes: statSync(archivePath).size,
      expectedFiles: expectedManifest.length,
      direct: alternating.direct,
      zinnia: alternating.zinnia,
      ratioSamples: ratioSamples(
        alternating.zinnia?.measuredMs,
        alternating.direct?.measuredMs,
      ),
      zinniaAvailable: true,
      status:
        alternating.direct?.error || alternating.zinnia?.error
          ? "failed"
          : "measured",
    };
  }
  const direct = runBackend({
    backend: "7z",
    archivePath,
    outputRoot: join(runRoot, "7z"),
    fixture,
    expectedManifest,
    format,
    workload,
    command: sidecar,
  });
  return {
    workload,
    format,
    compatibility: FORMATS[format].compatibility,
    archiveBytes: statSync(archivePath).size,
    expectedFiles: expectedManifest.length,
    direct,
    zinnia: null,
    ratioSamples: [],
    zinniaAvailable: false,
    status: direct.error ? "failed" : "zinnia-unavailable",
  };
}

function operationSourcePath(fixture) {
  return join(fixture.root, fixture.source);
}

function operationExpectedManifest(operation, format, fixture) {
  const expected = outputManifest(format, fixture);
  if (operation !== "selective-extract") return expected;
  return expected.length > 0 ? [expected[0]] : [];
}

function operationTargetFormat(format) {
  return format === "7z" ? "zip" : "7z";
}

function operationContext({
  operation,
  archivePath,
  targetPath,
  outputRoot,
  fixture,
  format,
  workload,
  selection,
  sourcePath,
}) {
  return {
    archive: archivePath,
    input: archivePath,
    output: outputRoot,
    target: targetPath || outputRoot,
    format,
    workload,
    root: fixture.root,
    operation,
    selection: selection || "",
    source: sourcePath || operationSourcePath(fixture),
  };
}

function operationState({
  operation,
  archivePath,
  fixture,
  format,
  workload,
  runRoot,
  backend,
  iterationLabel,
}) {
  const root = join(runRoot, backend, operation, iterationLabel);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const outputRoot = join(root, "output");
  const targetFormat =
    operation === "conversion" ? operationTargetFormat(format) : format;
  const targetPath = join(root, `result.${FORMATS[targetFormat].extension}`);
  const selection = outputManifest(format, fixture)[0]?.path || "";
  const replacementRoot = join(root, "replacement");
  const replacementPath = join(replacementRoot, fixture.source);
  if (["replace", "update"].includes(operation)) {
    if (fixture.source === "payload") {
      for (const [index, entry] of fixture.manifest.entries()) {
        const replacementEntry = join(replacementRoot, entry.path);
        mkdirSync(dirname(replacementEntry), { recursive: true });
        writeDeterministicFile(
          replacementEntry,
          entry.bytes,
          (0xfeedcafe + index * 0x10203) >>> 0,
        );
      }
    } else if (fixture.manifest.length > 0) {
      mkdirSync(dirname(replacementPath), { recursive: true });
      const first = fixture.manifest[0];
      writeDeterministicFile(replacementPath, first.bytes, 0xfeedcafe);
    }
    // Update mode compares source timestamps. Keep replacement contents
    // deterministic while making them intentionally newer than the fixture so
    // the measured update has a defined, verifiable result.
    setDeterministicTimes(
      replacementRoot,
      new Date("2021-01-01T00:00:00.000Z"),
    );
  }
  return {
    root,
    outputRoot,
    targetPath,
    selection,
    replacementRoot,
    replacementPath,
    fixture,
    archivePath,
    format,
    targetFormat,
    workload,
  };
}

function assertArchiveOutput(sidecar, targetPath, label) {
  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
    throw new Error(`${label} did not produce an archive output`);
  }
  assertSuccess(
    runProcess(sidecar, ["t", "--", targetPath]),
    `${label} archive verification`,
  );
}

function expectedArchiveManifestForOperation(
  operation,
  state,
  format,
  fixture,
) {
  if (["replace", "update"].includes(operation)) {
    return fixtureManifest(state.replacementRoot);
  }
  if (operation === "conversion") {
    return outputManifest(state.targetFormat, fixture);
  }
  return outputManifest(format, fixture);
}

function verifyArchiveOperationOutput(
  sidecar,
  state,
  operation,
  format,
  fixture,
  label,
) {
  assertArchiveOutput(sidecar, state.targetPath, label);
  const verificationRoot = join(state.root, "verified-output");
  rmSync(verificationRoot, { recursive: true, force: true });
  mkdirSync(verificationRoot, { recursive: true });
  const targetFormat = operation === "conversion" ? state.targetFormat : format;
  const extract = runProcess(
    sidecar,
    directExtractArgs(state.targetPath, verificationRoot),
    { cwd: fixture.root },
  );
  assertSuccess(extract, `${label} content verification`);
  const verification = verifyOutputTree(
    verificationRoot,
    expectedArchiveManifestForOperation(
      operation,
      state,
      targetFormat,
      fixture,
    ),
  );
  if (!verification.ok) {
    throw new Error(`${label} content verification: ${verification.reason}`);
  }
}

function runDirectOperationOnce({
  operation,
  sidecar,
  archivePath,
  fixture,
  format,
  workload,
  runRoot,
  iterationLabel,
}) {
  const state = operationState({
    operation,
    archivePath,
    fixture,
    format,
    workload,
    runRoot,
    backend: "7z",
    iterationLabel,
  });
  const expected = operationExpectedManifest(operation, format, fixture);
  let browseStdout = "";
  if (["replace", "update"].includes(operation)) {
    // Prepare an independent target outside the measured 7-Zip interval. The
    // operation timing then reflects archive I/O, not fixture bookkeeping.
    copyFileSync(archivePath, state.targetPath);
  }
  const started = performance.now();
  const run = (args, cwd = fixture.root, label = operation) => {
    const result = runProcess(sidecar, args, { cwd });
    assertSuccess(result, `7z ${label} ${workload}/${format}`);
    browseStdout = result.stdout;
    return result;
  };

  switch (operation) {
    case "browse":
      run(["l", "-slt", "-ba", "--", archivePath]);
      {
        const verification = verifyBrowseListing(browseStdout, expected);
        if (!verification.ok)
          throw new Error(`7z browse: ${verification.reason}`);
      }
      break;
    case "test":
      run(["t", "--", archivePath]);
      break;
    case "extract":
      mkdirSync(state.outputRoot, { recursive: true });
      run(directExtractArgs(archivePath, state.outputRoot));
      break;
    case "selective-extract":
      mkdirSync(state.outputRoot, { recursive: true });
      run(
        [
          "x",
          "-y",
          `-o${state.outputRoot}`,
          "--",
          archivePath,
          state.selection,
        ],
        fixture.root,
        "selective-extract",
      );
      break;
    case "create":
      run(directCreateArgs(format, state.targetPath, fixture.source));
      break;
    case "replace":
    case "update":
      run(
        [
          operation === "update" ? "u" : "a",
          ...FORMATS[format].switches,
          state.targetPath,
          "--",
          fixture.source,
        ],
        state.replacementRoot,
        operation,
      );
      break;
    case "conversion": {
      const convertedRoot = join(state.root, "converted-input");
      mkdirSync(convertedRoot, { recursive: true });
      run(
        directExtractArgs(archivePath, convertedRoot),
        fixture.root,
        "conversion-extract",
      );
      const targetFormat = operationTargetFormat(format);
      run(
        directCreateArgs(targetFormat, state.targetPath, "payload"),
        convertedRoot,
        "conversion-create",
      );
      break;
    }
    case "batch": {
      const first = join(state.outputRoot, "first");
      const second = join(state.outputRoot, "second");
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });
      run(directExtractArgs(archivePath, first), fixture.root, "batch-first");
      run(directExtractArgs(archivePath, second), fixture.root, "batch-second");
      break;
    }
    default:
      throw new Error(`Unsupported operation: ${operation}`);
  }
  const durationMs = performance.now() - started;

  if (["extract", "selective-extract"].includes(operation)) {
    const verification = verifyOutputTree(state.outputRoot, expected);
    if (!verification.ok)
      throw new Error(`7z ${operation}: ${verification.reason}`);
  } else if (operation === "batch") {
    for (const name of ["first", "second"]) {
      const verification = verifyOutputTree(
        join(state.outputRoot, name),
        expected,
      );
      if (!verification.ok)
        throw new Error(`7z batch/${name}: ${verification.reason}`);
    }
  } else if (operation === "conversion") {
    verifyArchiveOperationOutput(
      sidecar,
      state,
      operation,
      format,
      fixture,
      "7z conversion",
    );
    const verification = verifyOutputTree(
      join(state.root, "converted-input"),
      outputManifest(format, fixture),
    );
    if (!verification.ok)
      throw new Error(`7z conversion input: ${verification.reason}`);
  } else if (["create", "replace", "update"].includes(operation)) {
    verifyArchiveOperationOutput(
      sidecar,
      state,
      operation,
      format,
      fixture,
      `7z ${operation}`,
    );
  }
  return { durationMs, code: 0 };
}

function runZinniaOperationOnce({
  operation,
  template,
  sidecar,
  archivePath,
  fixture,
  format,
  workload,
  runRoot,
  iterationLabel,
}) {
  const state = operationState({
    operation,
    archivePath,
    fixture,
    format,
    workload,
    runRoot,
    backend: "zinnia",
    iterationLabel,
  });
  const targetFormat = operationTargetFormat(format);
  const context = operationContext({
    operation,
    archivePath,
    targetPath: state.targetPath,
    outputRoot: state.outputRoot,
    fixture,
    format,
    workload,
    selection: state.selection,
    sourcePath: ["replace", "update"].includes(operation)
      ? state.replacementPath
      : operationSourcePath(fixture),
  });
  context.targetFormat = targetFormat;
  const rendered = commandTemplateFor(template, context);
  if (rendered.length === 0) throw new Error("empty Zinnia operation command");
  if (["replace", "update"].includes(operation)) {
    copyFileSync(archivePath, state.targetPath);
  }
  const started = performance.now();
  const result = runProcess(rendered[0], rendered.slice(1), {
    cwd: fixture.root,
    env: {
      ...process.env,
      ZINNIA_BENCH_OPERATION: operation,
      ZINNIA_BENCH_ARCHIVE: archivePath,
      ZINNIA_BENCH_INPUT: archivePath,
      ZINNIA_BENCH_OUTPUT: state.outputRoot,
      ZINNIA_BENCH_TARGET: state.targetPath,
      ZINNIA_BENCH_FORMAT: format,
      ZINNIA_BENCH_TARGET_FORMAT: targetFormat,
      ZINNIA_BENCH_WORKLOAD: workload,
      ZINNIA_BENCH_SELECTION: state.selection,
      ZINNIA_BENCH_SOURCE: context.source,
    },
  });
  assertSuccess(result, `Zinnia ${operation} ${workload}/${format}`);
  if (operation === "browse" && result.stdout) {
    const browseVerification = verifyBrowseListing(
      result.stdout,
      operationExpectedManifest(operation, format, fixture),
    );
    if (!browseVerification.ok) {
      throw new Error(`Zinnia browse: ${browseVerification.reason}`);
    }
  }
  const durationMs = performance.now() - started;
  const expected = operationExpectedManifest(operation, format, fixture);
  if (["extract", "selective-extract"].includes(operation)) {
    const verification = verifyOutputTree(state.outputRoot, expected);
    if (!verification.ok)
      throw new Error(`Zinnia ${operation}: ${verification.reason}`);
  } else if (operation === "batch") {
    for (const name of ["first", "second"]) {
      const verification = verifyOutputTree(
        join(state.outputRoot, name),
        expected,
      );
      if (!verification.ok)
        throw new Error(`Zinnia batch/${name}: ${verification.reason}`);
    }
  } else if (
    ["create", "replace", "update", "conversion"].includes(operation)
  ) {
    verifyArchiveOperationOutput(
      sidecar,
      state,
      operation,
      format,
      fixture,
      `Zinnia ${operation}`,
    );
  }
  return { durationMs, code: result.code };
}

async function runAsyncZinniaOperationOnce({
  operation,
  executor,
  batchExecutor,
  sidecar,
  archivePath,
  fixture,
  format,
  workload,
  runRoot,
  iterationLabel,
}) {
  const state = operationState({
    operation,
    archivePath,
    fixture,
    format,
    workload,
    runRoot,
    backend: "zinnia",
    iterationLabel,
  });
  const targetFormat = state.targetFormat;
  const sourcePath = ["replace", "update"].includes(operation)
    ? state.replacementPath
    : operationSourcePath(fixture);
  const request = createArchiveBenchmarkRequest({
    operation,
    archive: archivePath,
    source: sourcePath,
    output: state.outputRoot,
    target: state.targetPath,
    selection: state.selection,
    format,
    targetFormat,
    workload,
  });
  if (["extract", "selective-extract", "batch"].includes(operation)) {
    mkdirSync(state.outputRoot, { recursive: true });
  }
  if (["replace", "update"].includes(operation)) {
    copyFileSync(archivePath, state.targetPath);
  }
  const execute =
    operation === "batch" && batchExecutor
      ? typeof batchExecutor === "function"
        ? batchExecutor
        : batchExecutor.run.bind(batchExecutor)
      : executor.run;
  const result = await timedAsyncInvocation(
    () => execute(request),
    [fixture.root, archivePath, state.outputRoot, state.targetPath, sourcePath],
  );
  const expected = operationExpectedManifest(operation, format, fixture);
  if (["extract", "selective-extract"].includes(operation)) {
    const verification = verifyOutputTree(state.outputRoot, expected);
    if (!verification.ok)
      throw new Error(`Zinnia ${operation}: ${verification.reason}`);
  } else if (operation === "batch") {
    for (const name of ["first", "second"]) {
      const verification = verifyOutputTree(
        join(state.outputRoot, name),
        expected,
      );
      if (!verification.ok)
        throw new Error(`Zinnia batch/${name}: ${verification.reason}`);
    }
  } else if (operation === "browse") {
    // Product runner may return listing stdout. If it does not, code 0 is the
    // runner's explicit successful listing verification contract.
    if (result.stdout) {
      const verification = verifyBrowseListing(result.stdout, expected);
      if (!verification.ok)
        throw new Error(`Zinnia browse: ${verification.reason}`);
    }
  } else if (
    ["create", "replace", "update", "conversion"].includes(operation)
  ) {
    verifyArchiveOperationOutput(
      sidecar,
      state,
      operation,
      format,
      fixture,
      `Zinnia ${operation}`,
    );
  }
  return { durationMs: result.durationMs, code: result.code };
}

async function runAsyncZinniaExtractOnce({
  executor,
  archivePath,
  fixture,
  expectedManifest,
  format,
  workload,
  runRoot,
  iterationLabel,
  password = "",
}) {
  const outputRoot = join(runRoot, "zinnia", "extract", iterationLabel);
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const request = createArchiveBenchmarkRequest({
    operation: "extract",
    archive: archivePath,
    source: operationSourcePath(fixture),
    output: outputRoot,
    target: outputRoot,
    format,
    targetFormat: format,
    workload,
    password,
  });
  const result = await timedAsyncInvocation(
    () => executor.run(request),
    [fixture.root, archivePath, outputRoot],
  );
  const verification = verifyOutputTree(outputRoot, expectedManifest);
  if (!verification.ok)
    throw new Error(`Zinnia extract: ${verification.reason}`);
  return { durationMs: result.durationMs, code: result.code };
}

function operationBackendSummary(runs) {
  return summarizeBackendRuns(runs);
}

function normalizeAsyncExecutor(rawExecutor) {
  if (!rawExecutor) return null;
  if (typeof rawExecutor === "function") {
    return { run: rawExecutor, close: null };
  }
  if (typeof rawExecutor.runArchiveBenchmarkOperation === "function") {
    return {
      run: rawExecutor.runArchiveBenchmarkOperation.bind(rawExecutor),
      close:
        typeof rawExecutor.close === "function"
          ? rawExecutor.close.bind(rawExecutor)
          : null,
    };
  }
  if (typeof rawExecutor.run === "function") {
    return {
      run: rawExecutor.run.bind(rawExecutor),
      close:
        typeof rawExecutor.close === "function"
          ? rawExecutor.close.bind(rawExecutor)
          : null,
    };
  }
  throw new Error(
    "Zinnia benchmark executor must be a function or expose run(request).",
  );
}

async function openBenchmarkExecutor(rawExecutor) {
  if (!rawExecutor) return null;
  if (
    typeof rawExecutor === "object" &&
    typeof rawExecutor.run !== "function" &&
    typeof rawExecutor.runArchiveBenchmarkOperation !== "function" &&
    (typeof rawExecutor.start === "function" ||
      typeof rawExecutor.create === "function")
  ) {
    const started = await (rawExecutor.start || rawExecutor.create).call(
      rawExecutor,
    );
    return normalizeAsyncExecutor(started);
  }
  return normalizeAsyncExecutor(rawExecutor);
}

export function createArchiveBenchmarkRequest({
  operation,
  archive,
  source,
  output,
  target,
  selection = "",
  format,
  targetFormat = format,
  workload,
  password,
}) {
  return {
    operation,
    archive,
    source,
    output,
    target,
    selection,
    format,
    targetFormat,
    workload,
    ...(password == null ? {} : { password }),
  };
}

async function timedAsyncInvocation(callback, redactionPaths = []) {
  const started = performance.now();
  const returned = await callback();
  const elapsedMs = performance.now() - started;
  const result = returned && typeof returned === "object" ? returned : {};
  const code = result.code == null ? 0 : result.code;
  if (code !== 0) {
    throw new Error(
      `executor failed with code ${code}${result.stdout ? `: ${safeError(result.stdout, redactionPaths)}` : ""}`,
    );
  }
  if (result.verified === false || result.verification?.ok === false) {
    throw new Error(
      result.verification?.reason || "executor output verification failed",
    );
  }
  const durationMs = Number.isFinite(result.durationMs)
    ? result.durationMs
    : elapsedMs;
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error("executor returned invalid durationMs");
  }
  return {
    durationMs,
    code,
    stdout: result.stdout == null ? "" : String(result.stdout),
  };
}

/**
 * Execute direct and Zinnia callbacks with one warm-up and five measured
 * samples. Measured order alternates per iteration. Callback durationMs is
 * product time; transport time is used only when callback omits durationMs.
 */
export async function runAlternatingExecutorPair({
  direct,
  zinnia,
  measuredIterations = MEASURED_ITERATIONS,
  warmupIterations = WARMUP_ITERATIONS,
  redactionPaths = [],
}) {
  if (typeof direct !== "function") throw new Error("direct callback required");
  if (!Number.isInteger(measuredIterations) || measuredIterations < 1) {
    throw new Error("measuredIterations must be a positive integer");
  }
  if (!Number.isInteger(warmupIterations) || warmupIterations < 0) {
    throw new Error("warmupIterations must be a non-negative integer");
  }
  const results = {
    direct: createBackendResult(),
    zinnia: zinnia ? createBackendResult() : null,
  };
  const callbacks = { direct, zinnia };
  const invoke = async (backend, phase, iteration) => {
    const callback = callbacks[backend];
    if (!callback) return;
    const run = await timedAsyncInvocation(
      () => callback({ phase, iteration }),
      redactionPaths,
    );
    results[backend][phase].push(run);
  };
  const backends = zinnia ? ["direct", "zinnia"] : ["direct"];
  for (let index = 0; index < warmupIterations; index += 1) {
    for (const backend of backends) {
      if (results[backend].error != null) continue;
      try {
        await invoke(backend, "warmup", index);
      } catch (error) {
        recordBackendFailure(results[backend], error, redactionPaths);
      }
    }
  }
  for (let index = 0; index < measuredIterations; index += 1) {
    const order = index % 2 === 0 ? backends : [...backends].reverse();
    for (const backend of order) {
      if (results[backend].error != null) continue;
      try {
        await invoke(backend, "measured", index);
      } catch (error) {
        recordBackendFailure(results[backend], error, redactionPaths);
      }
    }
  }
  for (const backend of backends) {
    const result = results[backend];
    if (result.error == null && result.measured.length !== measuredIterations) {
      recordBackendFailure(
        result,
        new Error(
          `${backend} produced ${result.measured.length} measured samples; expected ${measuredIterations}`,
        ),
        redactionPaths,
      );
    }
  }
  return {
    direct: summarizeBackendRuns(results.direct),
    zinnia: results.zinnia ? summarizeBackendRuns(results.zinnia) : null,
    ratioSamples: results.zinnia
      ? ratioSamples(
          results.zinnia.measured.map((run) => run.durationMs),
          results.direct.measured.map((run) => run.durationMs),
        )
      : [],
  };
}

function runOperationBackends({
  operation,
  archivePath,
  fixture,
  format,
  workload,
  sidecar,
  zinniaTemplate,
  runRoot,
}) {
  const backends = ["7z", "zinnia"];
  const results = {
    "7z": { warmup: [], measured: [], verified: true, error: null },
    zinnia: { warmup: [], measured: [], verified: true, error: null },
  };
  const invoke = (backend, iterationLabel) =>
    backend === "7z"
      ? runDirectOperationOnce({
          operation,
          sidecar,
          archivePath,
          fixture,
          format,
          workload,
          runRoot,
          iterationLabel,
        })
      : runZinniaOperationOnce({
          operation,
          template: zinniaTemplate,
          sidecar,
          archivePath,
          fixture,
          format,
          workload,
          runRoot,
          iterationLabel,
        });
  for (const backend of backends) {
    if (backend === "zinnia" && !zinniaTemplate) continue;
    try {
      results[backend].warmup.push(invoke(backend, "warmup"));
    } catch (error) {
      recordBackendFailure(results[backend], error);
    }
  }
  for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
    const order = index % 2 === 0 ? backends : [...backends].reverse();
    for (const backend of order) {
      if (backend === "zinnia" && !zinniaTemplate) continue;
      if (results[backend].error != null) continue;
      try {
        results[backend].measured.push(
          invoke(backend, `iteration-${index + 1}`),
        );
      } catch (error) {
        recordBackendFailure(results[backend], error);
      }
    }
  }
  return {
    direct: operationBackendSummary(results["7z"]),
    zinnia: zinniaTemplate ? operationBackendSummary(results.zinnia) : null,
  };
}

function operationReport({
  operation,
  fixture,
  archivePath,
  format,
  workload,
  sidecar,
  zinniaTemplates,
  runRoot,
}) {
  const template = zinniaTemplates?.[operation] || null;
  const measurements = runOperationBackends({
    operation,
    archivePath,
    fixture,
    format,
    workload,
    sidecar,
    zinniaTemplate: template,
    runRoot,
  });
  return {
    operation,
    workload,
    format,
    compatibility:
      operation === "conversion"
        ? `${format} -> ${operationTargetFormat(format)}`
        : operation === "batch"
          ? "aggregate sequence"
          : FORMATS[format].compatibility,
    direct: measurements.direct,
    zinnia: measurements.zinnia,
    ratioSamples: ratioSamples(
      measurements.zinnia?.measuredMs,
      measurements.direct?.measuredMs,
    ),
    zinniaAvailable: Boolean(template),
    status: measurements.direct.error
      ? "failed"
      : template
        ? measurements.zinnia?.error
          ? "failed"
          : "measured"
        : "zinnia-unavailable",
  };
}

function measurementStatus(measurements, zinniaExpected) {
  if (measurements.direct?.error) return "failed";
  if (!zinniaExpected) return "zinnia-unavailable";
  if (measurements.zinnia?.error) return "failed";
  return "measured";
}

async function caseReportAsync({
  fixture,
  archivePath,
  format,
  workload,
  sidecar,
  executor,
  runRoot,
}) {
  const expectedManifest = outputManifest(format, fixture);
  const measurements = await runAlternatingExecutorPair({
    direct: ({ phase, iteration }) =>
      runBackendIteration({
        backend: "7z",
        archivePath,
        outputRoot: join(runRoot, "7z"),
        fixture,
        expectedManifest,
        format,
        workload,
        command: sidecar,
        iteration,
        warmup: phase === "warmup",
      }),
    zinnia: ({ phase, iteration }) =>
      runAsyncZinniaExtractOnce({
        executor,
        archivePath,
        fixture,
        expectedManifest,
        format,
        workload,
        runRoot,
        iterationLabel:
          phase === "warmup" ? "warmup" : `iteration-${iteration + 1}`,
      }),
    redactionPaths: [fixture.root, archivePath, runRoot],
  });
  return {
    workload,
    format,
    compatibility: FORMATS[format].compatibility,
    archiveBytes: statSync(archivePath).size,
    expectedFiles: expectedManifest.length,
    direct: measurements.direct,
    zinnia: measurements.zinnia,
    ratioSamples: measurements.ratioSamples,
    zinniaAvailable: true,
    status: measurementStatus(measurements, true),
  };
}

async function compatibilityReportAsync({
  name,
  fixture,
  archivePath,
  format,
  password,
  sidecar,
  executor,
  runRoot,
}) {
  const expectedManifest = fixture.manifest;
  const measurements = await runAlternatingExecutorPair({
    direct: ({ phase, iteration }) =>
      runBackendIteration({
        backend: "7z",
        archivePath,
        outputRoot: join(runRoot, "7z"),
        fixture,
        expectedManifest,
        format,
        workload: name,
        command: sidecar,
        password,
        iteration,
        warmup: phase === "warmup",
      }),
    zinnia: executor
      ? ({ phase, iteration }) =>
          runAsyncZinniaExtractOnce({
            executor,
            archivePath,
            fixture,
            expectedManifest,
            format,
            workload: name,
            password,
            runRoot,
            iterationLabel:
              phase === "warmup" ? "warmup" : `iteration-${iteration + 1}`,
          })
      : null,
    redactionPaths: [fixture.root, archivePath, runRoot, password],
  });
  const zinniaExpected = Boolean(executor);
  return {
    name,
    primary: false,
    format,
    direct: measurements.direct,
    zinnia: measurements.zinnia,
    ratioSamples: measurements.ratioSamples,
    zinniaAvailable: zinniaExpected,
    required: zinniaExpected,
    status: measurementStatus(measurements, zinniaExpected),
    // Compatibility rows are deliberately not part of target/trend rollups.
    targetStatus: "not-applicable",
    trendStatus: "baseline-unavailable",
  };
}

function unavailableCompatibilityReport(name, reason) {
  return {
    name,
    primary: false,
    status: "not-available",
    required: false,
    zinniaAvailable: false,
    direct: null,
    zinnia: null,
    ratioSamples: [],
    targetStatus: "not-applicable",
    trendStatus: "baseline-unavailable",
    note: reason,
  };
}

function failedCompatibilityReport(name, error, executor) {
  const password = name === "encrypted" ? COMPATIBILITY_PASSWORD : "";
  const message = password
    ? safeError(error).split(password).join("<redacted>")
    : safeError(error);
  return {
    name,
    primary: false,
    status: "failed",
    required: Boolean(executor),
    zinniaAvailable: Boolean(executor),
    direct: {
      warmupMs: [],
      measuredMs: [],
      medianMs: null,
      medianAbsoluteDeviationMs: null,
      relativeMedianAbsoluteDeviation: null,
      verified: false,
      error: message,
    },
    zinnia: null,
    ratioSamples: [],
    targetStatus: "not-applicable",
    trendStatus: "baseline-unavailable",
  };
}

async function runCompatibilityMeasurements({
  sidecar,
  executor,
  workRoot,
  archiveRoot,
  runRoot,
}) {
  const rows = [];
  for (const name of ["rar", "split", "encrypted", "link-bearing"]) {
    try {
      const fixture = createCompatibilityFixture(workRoot, name);
      const archive = createCompatibilityArchive(
        name,
        fixture,
        sidecar,
        archiveRoot,
      );
      rows.push(
        await compatibilityReportAsync({
          name,
          fixture,
          archivePath: archive.archivePath,
          format: archive.format,
          password: archive.password,
          sidecar,
          executor,
          runRoot: join(runRoot, `compatibility-${name}`),
        }),
      );
    } catch (error) {
      if (name === "link-bearing") {
        rows.push(
          unavailableCompatibilityReport(
            name,
            `not-available: ${safeError(error)}`,
          ),
        );
      } else {
        rows.push(failedCompatibilityReport(name, error, executor));
      }
    }
  }
  // These capability classes are intentionally not approximated with a
  // substitute fixture. Keep them in the machine-readable compatibility
  // table so reports say explicitly that no timing was available, while the
  // rows remain outside target/trend and hard-failure rollups.
  rows.push(
    unavailableCompatibilityReport(
      "unsupported-filesystem",
      "not-available: benchmark runner did not provision a filesystem with the required feature set",
    ),
    unavailableCompatibilityReport(
      "custom-acl",
      "not-available: benchmark runner did not provision a matching custom-ACL fixture",
    ),
  );
  return rows;
}

async function operationReportAsync({
  operation,
  fixture,
  archivePath,
  format,
  workload,
  sidecar,
  executor,
  batchExecutor,
  runRoot,
}) {
  const measurements = await runAlternatingExecutorPair({
    direct: ({ phase, iteration }) =>
      runDirectOperationOnce({
        operation,
        sidecar,
        archivePath,
        fixture,
        format,
        workload,
        runRoot,
        iterationLabel:
          phase === "warmup" ? "warmup" : `iteration-${iteration + 1}`,
      }),
    zinnia: ({ phase, iteration }) =>
      runAsyncZinniaOperationOnce({
        operation,
        executor,
        batchExecutor,
        sidecar,
        archivePath,
        fixture,
        format,
        workload,
        runRoot,
        iterationLabel:
          phase === "warmup" ? "warmup" : `iteration-${iteration + 1}`,
      }),
    redactionPaths: [fixture.root, archivePath, runRoot],
  });
  return {
    operation,
    workload,
    format,
    compatibility:
      operation === "conversion"
        ? `${format} -> ${operationTargetFormat(format)}`
        : operation === "batch"
          ? "aggregate sequence"
          : FORMATS[format].compatibility,
    direct: measurements.direct,
    zinnia: measurements.zinnia,
    ratioSamples: measurements.ratioSamples,
    zinniaAvailable: true,
    status: measurementStatus(measurements, true),
  };
}

export function ratio(zinniaMedianMs, directMedianMs) {
  if (
    !Number.isFinite(zinniaMedianMs) ||
    !Number.isFinite(directMedianMs) ||
    directMedianMs <= 0
  ) {
    return null;
  }
  return zinniaMedianMs / directMedianMs;
}

function comparisonItemKey(item) {
  return item.operation
    ? `operation:${item.operation}/${item.workload}/${item.format}`
    : `case:${item.workload}/${item.format}`;
}

function itemRatioSamples(item) {
  const explicit = finiteNumbers(item?.ratioSamples);
  if (explicit.length > 0) return explicit;
  return ratioSamples(item?.zinnia?.measuredMs, item?.direct?.measuredMs);
}

export function itemRatioStats(item) {
  const samples = itemRatioSamples(item);
  const candidateRatio =
    Number.isFinite(item?.candidateRatio) && item.candidateRatio > 0
      ? item.candidateRatio
      : (ratio(item?.zinnia?.medianMs, item?.direct?.medianMs) ??
        median(samples));
  const ratioMad = medianAbsoluteDeviation(samples);
  const relativeMad = relativeMedianAbsoluteDeviation(samples);
  return {
    samples,
    candidateRatio,
    ratioMad,
    relativeMad,
  };
}

export function targetLimitForWorkload(workload) {
  return TARGET_LIMITS[workload] ?? null;
}

export function classifyTargetStatus(
  candidateRatio,
  workload,
  applicable = true,
) {
  if (!applicable || !Number.isFinite(candidateRatio)) return "not-applicable";
  const limit = targetLimitForWorkload(workload);
  if (limit == null) return "not-applicable";
  return candidateRatio <= limit ? "met" : "missed";
}

export function classifyTrendStatus({
  candidateRatio,
  baselineRatio,
  candidateRelativeMad,
  baselineRelativeMad,
  baselineAvailable = true,
}) {
  if (!baselineAvailable || !Number.isFinite(baselineRatio)) {
    return "baseline-unavailable";
  }
  if (!Number.isFinite(candidateRatio) || baselineRatio <= 0) {
    return "baseline-unavailable";
  }
  if (
    (Number.isFinite(candidateRelativeMad) &&
      candidateRelativeMad > NOISE_THRESHOLD) ||
    (Number.isFinite(baselineRelativeMad) &&
      baselineRelativeMad > NOISE_THRESHOLD)
  ) {
    return "noisy";
  }
  const delta = (candidateRatio - baselineRatio) / baselineRatio;
  const epsilon = Number.EPSILON * 8;
  if (delta <= -TREND_THRESHOLD + epsilon) return "improved";
  if (delta >= TREND_THRESHOLD - epsilon) return "regressed";
  return "stable";
}

export function compareMeasurementItem(candidate, baseline = null) {
  const candidateStats = itemRatioStats(candidate);
  const baselineStats = baseline ? itemRatioStats(baseline) : null;
  const applicable = candidate?.status !== "not-applicable";
  const baselineRatio = baselineStats?.candidateRatio ?? null;
  const normalizedDelta =
    Number.isFinite(candidateStats.candidateRatio) &&
    Number.isFinite(baselineRatio) &&
    baselineRatio > 0
      ? (candidateStats.candidateRatio - baselineRatio) / baselineRatio
      : null;
  return {
    candidateRatio: candidateStats.candidateRatio ?? null,
    baselineRatio,
    normalizedDelta,
    ratioSamples: candidateStats.samples,
    medianAbsoluteDeviation: candidateStats.ratioMad,
    relativeMedianAbsoluteDeviation: candidateStats.relativeMad,
    candidateRatioMad: candidateStats.ratioMad,
    candidateRelativeMad: candidateStats.relativeMad,
    baselineMedianAbsoluteDeviation: baselineStats?.ratioMad ?? null,
    baselineRelativeMedianAbsoluteDeviation: baselineStats?.relativeMad ?? null,
    baselineRatioMad: baselineStats?.ratioMad ?? null,
    baselineRelativeMad: baselineStats?.relativeMad ?? null,
    targetStatus: classifyTargetStatus(
      candidateStats.candidateRatio,
      candidate?.workload,
      applicable,
    ),
    trendStatus: classifyTrendStatus({
      candidateRatio: candidateStats.candidateRatio,
      baselineRatio,
      candidateRelativeMad: candidateStats.relativeMad,
      baselineRelativeMad: baselineStats?.relativeMad,
      baselineAvailable: Boolean(baseline),
    }),
  };
}

function allMeasurementItems(report) {
  return [...(report?.cases ?? []), ...(report?.operations ?? [])];
}

function reportMetadata(report, fallbackAvailable = false) {
  const candidate = report?.candidate ?? {};
  const base = report?.base ?? report?.baseline ?? {};
  return {
    revision:
      candidate.revision ??
      report?.candidateRevision ??
      report?.revision ??
      null,
    ref: candidate.ref ?? report?.candidateRef ?? null,
    baseRevision: base.revision ?? report?.baseRevision ?? null,
    baseRef: base.ref ?? report?.baseRef ?? null,
    available: base.available ?? fallbackAvailable,
  };
}

function hardFailureMessages(report, { requireCandidate = true } = {}) {
  const failures = [...(report?.failures ?? [])];
  for (const item of allMeasurementItems(report)) {
    if (item.status === "not-applicable") continue;
    if (item.direct?.error || item.direct?.verified === false) {
      failures.push(
        `${comparisonItemKey(item)} direct measurement failed: ${item.direct.error || "verification failed"}`,
      );
    }
    if (item.zinnia?.error || item.zinnia?.verified === false) {
      failures.push(
        `${comparisonItemKey(item)} candidate measurement failed: ${item.zinnia.error || "verification failed"}`,
      );
    }
    const candidateMissing =
      item.status === "zinnia-unavailable" ||
      !item.zinnia ||
      !Number.isFinite(item.zinnia.medianMs) ||
      item.zinnia.measuredMs?.length !== MEASURED_ITERATIONS;
    if (requireCandidate && candidateMissing) {
      failures.push(`${comparisonItemKey(item)} candidate measurement missing`);
    }
  }
  return [...new Set(failures.map((failure) => redactText(failure)))];
}

/**
 * Attach target/trend fields to candidate report. Timing findings stay in
 * report.timingFindings and never enter hard failures.
 */
export function compareBenchmarkReports(
  candidateReport,
  baselineReport = null,
  { requireCandidate = true } = {},
) {
  const candidate = JSON.parse(JSON.stringify(candidateReport));
  const baselineByKey = new Map(
    allMeasurementItems(baselineReport).map((item) => [
      comparisonItemKey(item),
      item,
    ]),
  );
  const baselineAvailable = Boolean(baselineReport);
  const apply = (item) => {
    const comparison = compareMeasurementItem(
      item,
      baselineByKey.get(comparisonItemKey(item)) ?? null,
    );
    Object.assign(item, comparison);
    return item;
  };
  candidate.cases = (candidate.cases ?? []).map(apply);
  candidate.operations = (candidate.operations ?? []).map(apply);
  const metadata = reportMetadata(candidate, baselineAvailable);
  candidate.schemaVersion = 3;
  candidate.candidate = {
    revision: metadata.revision,
    ref: metadata.ref,
  };
  candidate.base = {
    revision:
      metadata.baseRevision ?? reportMetadata(baselineReport).revision ?? null,
    ref: metadata.baseRef ?? reportMetadata(baselineReport).ref ?? null,
    available: baselineAvailable,
  };
  candidate.candidateRevision = metadata.revision;
  candidate.baseRevision = candidate.base.revision;
  candidate.comparison = {
    baselineAvailable,
    baselineStatus: baselineAvailable ? "available" : "baseline-unavailable",
    targetStatus: "per-item",
    trendStatus: baselineAvailable ? "per-item" : "baseline-unavailable",
    targetLimits: TARGET_LIMITS,
    trendThreshold: TREND_THRESHOLD,
    noiseThreshold: NOISE_THRESHOLD,
  };
  const hardFailures = hardFailureMessages(candidate, { requireCandidate });
  const timingFindings = allMeasurementItems(candidate)
    .filter(
      (item) =>
        item.targetStatus === "missed" ||
        item.trendStatus === "regressed" ||
        item.trendStatus === "noisy",
    )
    .map((item) => ({
      key: comparisonItemKey(item),
      targetStatus: item.targetStatus,
      trendStatus: item.trendStatus,
      candidateRatio: item.candidateRatio,
      baselineRatio: item.baselineRatio,
    }));
  candidate.failures = hardFailures;
  candidate.timingFindings = timingFindings;
  candidate.timingStatus = timingFindings.length > 0 ? "findings" : "clear";
  return candidate;
}

export const compareReports = compareBenchmarkReports;

export function renderMarkdown(report) {
  const candidate = report.candidate ?? {};
  const base = report.base ?? {};
  const formatNumber = (value, digits = 3) =>
    Number.isFinite(value) ? value.toFixed(digits) : "n/a";
  const formatRatio = (value) =>
    Number.isFinite(value) ? `${value.toFixed(3)}x` : "n/a";
  const lines = [
    "# Zinnia archive I/O benchmark",
    "",
    `Generated: ${report.generatedAt}`,
    `Candidate: ${candidate.revision || report.candidateRevision || "unknown"}${candidate.ref ? ` (${candidate.ref})` : ""}`,
    `Base: ${base.available ? base.revision || report.baseRevision || "available" : "baseline unavailable"}${base.ref ? ` (${base.ref})` : ""}`,
    `Host: ${report.host.platform}/${report.host.arch}`,
    `Bundled 7-Zip: ${report.sevenZip.binary}`,
    `Fixture scale: ${report.protocol.fixtureScale} (${report.protocol.fixtureDescription})`,
    `Protocol: ${report.protocol.warmupIterations} warm-up + ${report.protocol.measuredIterations} measured; alternating backend order per iteration when Zinnia runner is configured`,
    "",
    "Wall-clock ratios are report-only. This report does not fail on timing thresholds.",
    "",
    `Hard failures: ${report.failures?.length ?? 0}. Timing findings: ${report.timingFindings?.length ?? 0}. Timing never changes gate status.`,
    "",
    "| Workload | Format | Compatibility | Files | Archive bytes | Direct median (ms) | Zinnia median (ms) | Candidate ratio | Baseline ratio | MAD | Target | Trend | Status |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
  ];
  for (const item of report.cases) {
    const direct =
      item.direct?.medianMs == null ? "n/a" : item.direct.medianMs.toFixed(2);
    const zinnia =
      item.zinnia?.medianMs == null ? "n/a" : item.zinnia.medianMs.toFixed(2);
    const speedRatio =
      item.candidateRatio ??
      ratio(item.zinnia?.medianMs, item.direct?.medianMs);
    const formattedRatio = formatRatio(speedRatio);
    const status =
      item.status ||
      (item.direct?.error || item.zinnia?.error ? "failed" : "measured");
    lines.push(
      `| ${item.workload} | ${item.format} | ${item.compatibility} | ${item.expectedFiles ?? "n/a"} | ${item.archiveBytes ?? "n/a"} | ${direct} | ${zinnia} | ${formattedRatio} | ${formatRatio(item.baselineRatio)} | ${formatNumber(item.medianAbsoluteDeviation)} | ${item.targetStatus || "n/a"} | ${item.trendStatus || "baseline-unavailable"} | ${status} |`,
    );
  }
  if (report.operations?.length > 0) {
    lines.push(
      "",
      "## Operation coverage",
      "",
      "| Operation | Workload | Format | Compatibility | Direct median (ms) | Zinnia median (ms) | Candidate ratio | Baseline ratio | MAD | Target | Trend | Status |",
      "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
    );
    for (const item of report.operations) {
      const direct =
        item.direct?.medianMs == null ? "n/a" : item.direct.medianMs.toFixed(2);
      const zinnia =
        item.zinnia?.medianMs == null ? "n/a" : item.zinnia.medianMs.toFixed(2);
      const speedRatio =
        item.candidateRatio ??
        ratio(item.zinnia?.medianMs, item.direct?.medianMs);
      const formattedRatio = formatRatio(speedRatio);
      lines.push(
        `| ${item.operation} | ${item.workload} | ${item.format} | ${item.compatibility} | ${direct} | ${zinnia} | ${formattedRatio} | ${formatRatio(item.baselineRatio)} | ${formatNumber(item.medianAbsoluteDeviation)} | ${item.targetStatus || "n/a"} | ${item.trendStatus || "baseline-unavailable"} | ${item.status} |`,
      );
    }
  }
  if (report.compatibilityMeasurements?.length > 0) {
    lines.push(
      "",
      "## Compatibility timing (excluded from primary targets)",
      "",
      "| Case | Format | Direct median (ms) | Zinnia median (ms) | Status | Host note |",
      "| --- | --- | ---: | ---: | --- | --- |",
    );
    for (const item of report.compatibilityMeasurements) {
      lines.push(
        `| ${item.name} | ${item.format || "n/a"} | ${item.direct?.medianMs == null ? "n/a" : item.direct.medianMs.toFixed(2)} | ${item.zinnia?.medianMs == null ? "n/a" : item.zinnia.medianMs.toFixed(2)} | ${item.status} | ${item.note || "measured outside primary targets"} |`,
      );
    }
  }
  if (!report.zinnia?.configured) {
    lines.push(
      "",
      "Zinnia timings were not recorded: no `ZINNIA_BENCH_COMMAND` was provided. The repository has no stable headless archive-operation CLI, so the harness does not invent a substitute or fake Zinnia numbers. Release ratio gates require a configured operation-aware headless Zinnia runner.",
    );
  } else {
    lines.push(
      "",
      "The configured Zinnia adapter must provide a command for each operation whose ratio is reviewed; omitted operation keys remain unavailable and are not treated as zero or direct timings.",
    );
  }
  lines.push(
    "",
    "## Compatibility cases",
    "",
    ...report.compatibilityCases.map(
      (item) => `- **${item.name}** (${item.status}): ${item.note}`,
    ),
  );
  if (report.failures.length > 0) {
    lines.push(
      "",
      "## Failures",
      "",
      ...report.failures.map((failure) => `- ${failure}`),
    );
  }
  if (report.timingFindings?.length > 0) {
    lines.push(
      "",
      "## Timing findings (report only)",
      "",
      ...report.timingFindings.map(
        (finding) =>
          `- ${finding.key}: target=${finding.targetStatus}, trend=${finding.trendStatus}, candidate=${formatRatio(finding.candidateRatio)}, baseline=${formatRatio(finding.baselineRatio)}`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderGithubSummary(report) {
  return renderMarkdown(report);
}

function usage() {
  return [
    "Usage: node bench/archive-io/benchmark.mjs [options]",
    "",
    "Options:",
    "  --output-dir <path>       Write JSON and Markdown reports here.",
    "  --formats <list>          Comma-separated format list.",
    "  --workloads <list>        Comma-separated workload list.",
    "  --operations <list>       Operation list for the representative operation suite.",
    "  --operation-formats <list> ZIP/7z/TAR formats for operation suite (default: zip).",
    "  --operation-workloads <list> Workloads for operation suite (default: bulk).",
    "  --scale <smoke|release>   Fixture scale (smoke is CI-friendly; release is review-grade).",
    "  --zinnia-command <json>   JSON argv template or operation map; tokens include {operation}, {input}, {target}, {selection}, {archive}, {output}, {format}, {workload}, {root}, {source}.",
    "  --candidate-revision <id> Candidate revision metadata.",
    "  --base-revision <id>      Base revision metadata.",
    "  --candidate-ref <ref>     Candidate ref metadata.",
    "  --base-ref <ref>          Base ref metadata.",
    "  --baseline-report <path>  Compare this report and write trend fields.",
    "  --compatibility           Measure compatibility rows; unsupported capabilities are explicit not-available.",
    "  --require-zinnia          Fail when candidate measurements are missing.",
    "  --keep-workdir            Keep generated fixtures and outputs for debugging.",
    "",
    "Environment:",
    "  ZINNIA_BENCH_COMMAND      Same JSON argv template/map as --zinnia-command.",
    "  ZINNIA_BENCH_SCALE         Default fixture scale.",
    "  ZINNIA_BENCH_REPORT_DIR   Default report directory.",
    "  ZINNIA_BENCH_COMPATIBILITY=1  Enable compatibility rows.",
  ].join("\n");
}

export async function runBenchmark(options) {
  const operationList = options.operations || OPERATIONS;
  const operationFormats = options.operationFormats || ["zip"];
  const operationWorkloads = options.operationWorkloads || ["bulk"];
  const scaleName = options.scale || "smoke";
  const zinniaTemplates = options.zinniaCommand
    ? parseOperationCommandTemplates(options.zinniaCommand)
    : null;
  const executor = await openBenchmarkExecutor(
    options.zinniaExecutor ??
      options.asyncExecutor ??
      options.executor ??
      options.zinniaPersistentExecutor ??
      options.persistentExecutor,
  );
  const zinniaConfigured = Boolean(executor || zinniaTemplates);
  const batchExecutor =
    options.zinniaBatchExecutor ?? options.persistentBatchExecutor ?? null;
  const sidecar = hostSidecarPath();
  const workRoot = join(
    tmpdir(),
    `zinnia-archive-io-${process.pid}-${Date.now()}`,
  );
  const runRoot = join(workRoot, "runs");
  mkdirSync(runRoot, { recursive: true });
  const archiveRoot = join(workRoot, "archives");
  mkdirSync(archiveRoot, { recursive: true });
  const fixtureWorkloads = [
    ...new Set([...options.workloads, ...operationWorkloads]),
  ];
  const fixtures = new Map(
    fixtureWorkloads.map((workload) => [
      workload,
      createFixture(workRoot, workload, scaleName),
    ]),
  );
  const report = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    candidate: {
      revision: options.candidateRevision ?? null,
      ref: options.candidateRef ?? null,
    },
    base: {
      revision: options.baseRevision ?? null,
      ref: options.baseRef ?? null,
      available: false,
    },
    candidateRevision: options.candidateRevision ?? null,
    baseRevision: options.baseRevision ?? null,
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    sevenZip: { binary: basename(sidecar) },
    protocol: {
      warmupIterations: WARMUP_ITERATIONS,
      measuredIterations: MEASURED_ITERATIONS,
      alternatingOrder: zinniaConfigured,
      fixtureScale: scaleName,
      fixtureDescription: FIXTURE_SCALES[scaleName].description,
    },
    zinnia: {
      configured: zinniaConfigured,
      command: redactedCommandMap(zinniaTemplates),
      operations: executor
        ? OPERATIONS.slice()
        : zinniaTemplates
          ? Object.keys(zinniaTemplates)
          : [],
    },
    compatibilityCases: COMPATIBILITY_CASES,
    compatibilityMeasurements: [],
    cases: [],
    operations: [],
    failures: [],
  };

  try {
    for (const workload of options.workloads) {
      const fixture = fixtures.get(workload);
      for (const format of options.formats) {
        if (!applicable(format, workload)) {
          report.cases.push({
            workload,
            format,
            compatibility: FORMATS[format].compatibility,
            archiveBytes: null,
            expectedFiles: fixture.manifest.length,
            direct: null,
            zinnia: null,
            status: "not-applicable",
          });
          continue;
        }
        let archivePath;
        try {
          archivePath = createArchive(
            sidecar,
            fixture,
            format,
            workload,
            archiveRoot,
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          report.cases.push({
            workload,
            format,
            compatibility: FORMATS[format].compatibility,
            archiveBytes: null,
            expectedFiles: fixture.manifest.length,
            direct: {
              warmupMs: [],
              measuredMs: [],
              medianMs: null,
              verified: false,
              error: reason,
            },
            zinnia: null,
            status: "failed",
          });
          report.failures.push(`${workload}/${format} fixture: ${reason}`);
          continue;
        }
        const item = executor
          ? await caseReportAsync({
              fixture,
              archivePath,
              format,
              workload,
              sidecar,
              executor,
              runRoot: join(runRoot, `${workload}-${format}`),
            })
          : caseReport({
              fixture,
              archivePath,
              format,
              workload,
              sidecar,
              zinniaCommand: zinniaTemplates?.extract || null,
              runRoot: join(runRoot, `${workload}-${format}`),
            });
        report.cases.push(item);
        if (item.direct.error)
          report.failures.push(
            `${workload}/${format} direct 7z: ${item.direct.error}`,
          );
        if (item.zinnia?.error)
          report.failures.push(
            `${workload}/${format} Zinnia: ${item.zinnia.error}`,
          );
      }
    }

    for (const workload of operationWorkloads) {
      const fixture = fixtures.get(workload);
      for (const format of operationFormats) {
        let archivePath;
        try {
          if (!applicable(format, workload)) {
            for (const operation of operationList) {
              report.operations.push({
                operation,
                workload,
                format,
                compatibility: FORMATS[format].compatibility,
                direct: null,
                zinnia: null,
                zinniaAvailable: Boolean(
                  executor || zinniaTemplates?.[operation],
                ),
                status: "not-applicable",
              });
            }
            continue;
          }
          archivePath = createArchive(
            sidecar,
            fixture,
            format,
            workload,
            archiveRoot,
            `operation-${workload}-${format}`,
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          for (const operation of operationList) {
            report.operations.push({
              operation,
              workload,
              format,
              compatibility: FORMATS[format].compatibility,
              direct: {
                warmupMs: [],
                measuredMs: [],
                medianMs: null,
                verified: false,
                error: reason,
              },
              zinnia: null,
              zinniaAvailable: Boolean(
                executor || zinniaTemplates?.[operation],
              ),
              status: "failed",
            });
          }
          report.failures.push(
            `${workload}/${format} operation fixture: ${reason}`,
          );
          continue;
        }
        for (const operation of operationList) {
          if (!operationApplicable(operation, format, workload)) {
            report.operations.push({
              operation,
              workload,
              format,
              compatibility: FORMATS[format].compatibility,
              direct: null,
              zinnia: null,
              zinniaAvailable: Boolean(
                executor || zinniaTemplates?.[operation],
              ),
              status: "not-applicable",
            });
            continue;
          }
          const item = executor
            ? await operationReportAsync({
                operation,
                fixture,
                archivePath,
                format,
                workload,
                sidecar,
                executor,
                batchExecutor,
                runRoot: join(runRoot, `operation-${workload}-${format}`),
              })
            : operationReport({
                operation,
                fixture,
                archivePath,
                format,
                workload,
                sidecar,
                zinniaTemplates,
                runRoot: join(runRoot, `operation-${workload}-${format}`),
              });
          report.operations.push(item);
          if (item.direct?.error) {
            report.failures.push(
              `${operation}/${workload}/${format} direct 7z: ${item.direct.error}`,
            );
          }
          if (item.zinnia?.error) {
            report.failures.push(
              `${operation}/${workload}/${format} Zinnia: ${item.zinnia.error}`,
            );
          }
        }
      }
    }
    if (options.compatibility) {
      report.compatibilityMeasurements = await runCompatibilityMeasurements({
        sidecar,
        executor,
        workRoot,
        archiveRoot,
        runRoot,
      });
      for (const item of report.compatibilityMeasurements) {
        if (item.direct?.error) {
          report.failures.push(
            `compatibility/${item.name} direct 7z: ${item.direct.error}`,
          );
        }
        if (item.zinnia?.error) {
          report.failures.push(
            `compatibility/${item.name} Zinnia: ${item.zinnia.error}`,
          );
        }
        if (item.required && !item.zinnia) {
          report.failures.push(
            `compatibility/${item.name} candidate measurement missing`,
          );
        }
      }
    }
  } finally {
    if (executor?.close) {
      try {
        await executor.close();
      } catch (error) {
        report.failures.push(
          `Zinnia executor close failed: ${safeError(error)}`,
        );
      }
    }
    if (!options.keepWorkdir)
      rmSync(workRoot, { recursive: true, force: true });
  }

  let baselineReport = null;
  if (options.baselineReport) {
    try {
      baselineReport = JSON.parse(
        readFileSync(resolve(options.baselineReport), "utf8"),
      );
    } catch (error) {
      report.failures.push(
        `Baseline report unavailable: ${safeError(error, [options.baselineReport])}`,
      );
    }
  }
  const comparedReport = compareBenchmarkReports(report, baselineReport, {
    requireCandidate: Boolean(options.requireZinnia || zinniaConfigured),
  });
  Object.assign(report, comparedReport);

  mkdirSync(options.outputDir, { recursive: true });
  const suffix = `${process.platform}-${process.arch}`;
  const jsonPath = join(options.outputDir, `archive-io-${suffix}.json`);
  const markdownPath = join(options.outputDir, `archive-io-${suffix}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdown(report));
  console.log(`Archive I/O JSON report: ${jsonPath}`);
  console.log(`Archive I/O Markdown report: ${markdownPath}`);
  if (report.failures.length > 0) {
    throw new Error(
      `Archive I/O benchmark failed (${report.failures.length} case(s)); reports retained.`,
    );
  }
  return report;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    await runBenchmark(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
