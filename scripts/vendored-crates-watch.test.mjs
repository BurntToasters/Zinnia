import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecutionOf } from "./direct-execution.mjs";
import {
  CRATES_IO_API_URL,
  USER_AGENT,
  checkCrate,
  collectVendoredCrates,
  compareVersions,
  formatTable,
  parseCargoPackage,
  runReport,
} from "./vendored-crates-watch.mjs";

const WEBDRIVER_MANIFEST = `
[dependencies.tauri]
version = "2.10.0"

[dependencies]
serde = { version = "1.0", features = ["derive"] }

[lib]
name = "tauri_plugin_wdio_webdriver"

[package]
edition = "2021"
name = "tauri-plugin-wdio-webdriver" # the crate
version = "1.4.0"

[package.metadata.docs.rs]
version = "9.9.9"
`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stableResponse(maxStableVersion) {
  return jsonResponse({ crate: { max_stable_version: maxStableVersion } });
}

function crate(name, version) {
  return { name, version, manifestPath: `src-tauri/vendor/${name}/Cargo.toml` };
}

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

test("parseCargoPackage reads name and version from the [package] table only", () => {
  assert.deepEqual(parseCargoPackage(WEBDRIVER_MANIFEST), {
    name: "tauri-plugin-wdio-webdriver",
    version: "1.4.0",
  });
});

test("inline-table dependency versions do not leak into the package version", () => {
  const manifest = `
[dependencies]
serde = { version = "1.0", features = ["derive"] }

[package]
name = "tauri-plugin-updater"
version = "2.10.1"
`;
  assert.deepEqual(parseCargoPackage(manifest), {
    name: "tauri-plugin-updater",
    version: "2.10.1",
  });
});

test("array tables and [package.*] sub-tables do not supply the package name or version", () => {
  const manifest = `
[[bin]]
name = "helper"
version = "0.0.1"

[package.metadata]
name = "metadata-name"

[package]
name = "real-crate"
version = "3.2.1"
`;
  assert.deepEqual(parseCargoPackage(manifest), {
    name: "real-crate",
    version: "3.2.1",
  });
});

test("workspace-inherited versions are rejected instead of guessed", () => {
  assert.throws(
    () =>
      parseCargoPackage(`[package]
name = "a-crate"
version = { workspace = true }
`),
    /version/u,
  );
  assert.throws(
    () =>
      parseCargoPackage(`[package]
name = "a-crate"
version.workspace = true
`),
    /version/u,
  );
});

test("a missing package name or version is rejected", () => {
  assert.throws(
    () => parseCargoPackage(`[package]\nversion = "1.0.0"\n`),
    /name/u,
  );
  assert.throws(
    () => parseCargoPackage(`[package]\nname = "a-crate"\n`),
    /version/u,
  );
  assert.throws(
    () => parseCargoPackage(`[dependencies]\nversion = "1.0.0"\n`),
    /package/u,
  );
});

test("comments, single-quoted literals and spaced table headers are accepted", () => {
  const manifest = `[ package ] # metadata
name = 'tauri-plugin-x' # literal
version = "1.0.0-rc.1" # pre-release
`;
  assert.deepEqual(parseCargoPackage(manifest), {
    name: "tauri-plugin-x",
    version: "1.0.0-rc.1",
  });
});

test("a crate name that is not a plain crates.io name is rejected before it reaches a URL", () => {
  assert.throws(
    () => parseCargoPackage(`[package]\nname = "../evil"\nversion = "1.0.0"\n`),
    /name/u,
  );
});

test("a package version that is not semver is rejected", () => {
  assert.throws(
    () => parseCargoPackage(`[package]\nname = "a-crate"\nversion = "1.0"\n`),
    /version/u,
  );
});

test("compareVersions compares numeric components numerically", () => {
  assert.equal(compareVersions("1.10.0", "1.9.0") > 0, true);
  assert.equal(compareVersions("2.0.0", "1.99.99") > 0, true);
  assert.equal(compareVersions("1.4.0", "1.4.0"), 0);
  assert.equal(compareVersions("1.4.0", "1.4.1") < 0, true);
});

test("a pre-release sorts before its release", () => {
  assert.equal(compareVersions("2.0.0-rc.1", "2.0.0") < 0, true);
  assert.equal(compareVersions("2.0.0", "2.0.0-rc.1") > 0, true);
});

test("pre-release identifiers follow semver precedence", () => {
  const ascending = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  for (let index = 1; index < ascending.length; index += 1) {
    assert.equal(
      compareVersions(ascending[index - 1], ascending[index]) < 0,
      true,
      `${ascending[index - 1]} should sort before ${ascending[index]}`,
    );
  }
});

test("build metadata does not change precedence", () => {
  assert.equal(compareVersions("1.0.0+build.1", "1.0.0+build.2"), 0);
});

test("compareVersions rejects strings that are not semver", () => {
  assert.throws(() => compareVersions("1.0", "1.0.0"), /version/u);
  assert.throws(() => compareVersions("1.0.0", "latest"), /version/u);
});

test("a vendored version equal to the latest stable release is current", async () => {
  const { fetchImpl } = fakeFetch(() => stableResponse("1.4.0"));
  const row = await checkCrate(
    crate("tauri-plugin-wdio-webdriver", "1.4.0"),
    fetchImpl,
  );
  assert.equal(row.status, "current");
  assert.equal(row.latest, "1.4.0");
  assert.equal(row.detail, "");
});

test("an older vendored version is behind the latest stable release", async () => {
  const { fetchImpl } = fakeFetch(() => stableResponse("2.13.3"));
  const row = await checkCrate(
    crate("tauri-plugin-updater", "2.10.1"),
    fetchImpl,
  );
  assert.equal(row.status, "behind");
  assert.equal(row.vendored, "2.10.1");
  assert.equal(row.latest, "2.13.3");
});

test("a vendored pre-release ahead of the latest stable release is not reported as behind", async () => {
  const { fetchImpl } = fakeFetch(() => stableResponse("2.10.1"));
  const row = await checkCrate(
    crate("tauri-plugin-updater", "2.11.0-beta.1"),
    fetchImpl,
  );
  assert.equal(row.status, "current");
});

test("a 404 from crates.io means the crate is not on crates.io", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse({ errors: [] }, 404));
  const row = await checkCrate(crate("zinnia-local-only", "0.1.0"), fetchImpl);
  assert.equal(row.status, "not on crates.io");
  assert.equal(row.latest, "-");
});

test("a rejected request is a per-crate fetch failure, not a thrown error", async () => {
  const { fetchImpl } = fakeFetch(async () => {
    throw new TypeError("fetch failed");
  });
  const row = await checkCrate(
    crate("tauri-plugin-updater", "2.10.1"),
    fetchImpl,
  );
  assert.equal(row.status, "fetch failed");
  assert.match(row.detail, /network error/u);
});

test("a timed out request is reported as a timeout", async () => {
  const { fetchImpl } = fakeFetch(async () => {
    throw Object.assign(new Error("The operation timed out."), {
      name: "TimeoutError",
    });
  });
  const row = await checkCrate(
    crate("tauri-plugin-updater", "2.10.1"),
    fetchImpl,
  );
  assert.equal(row.status, "fetch failed");
  assert.match(row.detail, /timeout/u);
});

test("HTTP errors other than 404 are fetch failures that name the status", async () => {
  for (const status of [429, 503]) {
    const { fetchImpl } = fakeFetch(() => jsonResponse({}, status));
    const row = await checkCrate(
      crate("tauri-plugin-updater", "2.10.1"),
      fetchImpl,
    );
    assert.equal(row.status, "fetch failed");
    assert.equal(row.detail, `HTTP ${status}`);
  }
});

test("an unparseable response body is a fetch failure", async () => {
  const { fetchImpl } = fakeFetch(
    () => new Response("<html>maintenance</html>", { status: 200 }),
  );
  const row = await checkCrate(
    crate("tauri-plugin-updater", "2.10.1"),
    fetchImpl,
  );
  assert.equal(row.status, "fetch failed");
  assert.equal(row.detail, "invalid JSON");
});

test("a response without a stable version is a fetch failure", async () => {
  const { fetchImpl } = fakeFetch(() => stableResponse(null));
  const row = await checkCrate(
    crate("tauri-plugin-updater", "2.10.1"),
    fetchImpl,
  );
  assert.equal(row.status, "fetch failed");
  assert.equal(row.detail, "no stable version in response");
});

test("a response with a non-semver stable version is a fetch failure", async () => {
  const { fetchImpl } = fakeFetch(() => stableResponse("latest"));
  const row = await checkCrate(
    crate("tauri-plugin-updater", "2.10.1"),
    fetchImpl,
  );
  assert.equal(row.status, "fetch failed");
  assert.equal(row.detail, "invalid version in response");
});

test("requests use the crates.io API URL, the generic user agent and a timeout signal", async () => {
  const { fetchImpl, calls } = fakeFetch(() => stableResponse("1.4.0"));
  await checkCrate(crate("tauri-plugin-wdio-webdriver", "1.4.0"), fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://crates.io/api/v1/crates/tauri-plugin-wdio-webdriver",
  );
  assert.equal(CRATES_IO_API_URL, "https://crates.io/api/v1/crates");
  assert.equal(calls[0].init.headers["User-Agent"], USER_AGENT);
  assert.equal(USER_AGENT, "zinnia-vendored-crates-watch");
  assert.equal(calls[0].init.signal instanceof AbortSignal, true);
});

test("the table prints one row per crate with a reason for each failure", async () => {
  const rows = [
    await checkCrate(
      crate("tauri-plugin-wdio-webdriver", "1.4.0"),
      fakeFetch(() => stableResponse("1.4.0")).fetchImpl,
    ),
    await checkCrate(
      crate("tauri-plugin-updater", "2.10.1"),
      fakeFetch(() => stableResponse("2.13.3")).fetchImpl,
    ),
    await checkCrate(
      crate("zinnia-local-only", "0.1.0"),
      fakeFetch(() => jsonResponse({}, 404)).fetchImpl,
    ),
    await checkCrate(
      crate("tauri-plugin-other", "0.2.0"),
      fakeFetch(() => jsonResponse({}, 503)).fetchImpl,
    ),
  ];
  const table = formatTable(rows);
  const lines = table.trimEnd().split("\n");
  assert.match(lines[0], /Crate\s+Vendored\s+Latest stable\s+Status/u);
  assert.match(
    lines[2],
    /tauri-plugin-wdio-webdriver\s+1\.4\.0\s+1\.4\.0\s+current/u,
  );
  assert.match(
    lines[3],
    /tauri-plugin-updater\s+2\.10\.1\s+2\.13\.3\s+behind/u,
  );
  assert.match(
    lines[4],
    /zinnia-local-only\s+0\.1\.0\s+-\s+not on crates\.io/u,
  );
  assert.match(
    lines[5],
    /tauri-plugin-other\s+0\.2\.0\s+-\s+fetch failed \(HTTP 503\)/u,
  );
  const statusColumn = lines[0].indexOf("Status");
  for (const line of lines.slice(2)) {
    assert.match(
      line.slice(statusColumn),
      /^(current|behind|not on crates\.io|fetch failed)/u,
    );
  }
});

test("collectVendoredCrates reads each vendored Cargo.toml in name order and skips other entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendored-crates-watch-"));
  try {
    const vendor = path.join(root, "src-tauri", "vendor");
    fs.mkdirSync(path.join(vendor, "zeta"), { recursive: true });
    fs.mkdirSync(path.join(vendor, "alpha"), { recursive: true });
    fs.mkdirSync(path.join(vendor, "notes"), { recursive: true });
    fs.writeFileSync(path.join(vendor, "README.md"), "# vendored\n");
    fs.writeFileSync(
      path.join(vendor, "zeta", "Cargo.toml"),
      `[package]\nname = "zeta-plugin"\nversion = "0.2.0"\n`,
    );
    fs.writeFileSync(
      path.join(vendor, "alpha", "Cargo.toml"),
      `[package]\nname = "alpha-plugin"\nversion = "0.1.0"\n`,
    );
    const crates = collectVendoredCrates(root);
    assert.deepEqual(
      crates.map(({ name, version }) => ({ name, version })),
      [
        { name: "alpha-plugin", version: "0.1.0" },
        { name: "zeta-plugin", version: "0.2.0" },
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed vendored manifest fails the run instead of printing a guess", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendored-crates-watch-"));
  try {
    const dir = path.join(root, "src-tauri", "vendor", "broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "Cargo.toml"),
      `[package]\nname = "broken"\n`,
    );
    const { fetchImpl } = fakeFetch(() => stableResponse("1.0.0"));
    await assert.rejects(
      () => runReport({ root, fetchImpl, write: () => {} }),
      /version/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one failing crate does not stop the report for the others", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendored-crates-watch-"));
  try {
    const vendor = path.join(root, "src-tauri", "vendor");
    for (const [dirName, name, version] of [
      ["alpha", "alpha-plugin", "0.1.0"],
      ["beta", "beta-plugin", "0.3.0"],
    ]) {
      fs.mkdirSync(path.join(vendor, dirName), { recursive: true });
      fs.writeFileSync(
        path.join(vendor, dirName, "Cargo.toml"),
        `[package]\nname = "${name}"\nversion = "${version}"\n`,
      );
    }
    const { fetchImpl } = fakeFetch((url) =>
      url.endsWith("alpha-plugin")
        ? jsonResponse({}, 503)
        : stableResponse("0.3.0"),
    );
    const written = [];
    const rows = await runReport({
      root,
      fetchImpl,
      write: (text) => written.push(text),
    });
    assert.deepEqual(
      rows.map(({ crate, status }) => ({ crate, status })),
      [
        { crate: "alpha-plugin", status: "fetch failed" },
        { crate: "beta-plugin", status: "current" },
      ],
    );
    assert.match(
      written.join(""),
      /beta-plugin\s+0\.3\.0\s+0\.3\.0\s+current/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importing the module does not count as running it directly", () => {
  const moduleUrl = new URL("./vendored-crates-watch.mjs", import.meta.url)
    .href;
  assert.equal(isDirectExecutionOf(moduleUrl, process.argv[1]), false);
  assert.equal(isDirectExecutionOf(moduleUrl, undefined), false);
});

test("running the module by its own path counts as direct execution", () => {
  const modulePath = fileURLToPath(
    new URL("./vendored-crates-watch.mjs", import.meta.url),
  );
  assert.equal(
    isDirectExecutionOf(
      new URL("./vendored-crates-watch.mjs", import.meta.url).href,
      modulePath,
    ),
    true,
  );
});
