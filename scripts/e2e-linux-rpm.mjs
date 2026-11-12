#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "linux", "Run this packaging check on Linux");
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "coverage/linux-rpm-prerelease");
fs.mkdirSync(output, { recursive: true });
const cli = require.resolve("@tauri-apps/cli/tauri.js");
const results = [];
function run(command, args, cwd, logName) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  fs.writeFileSync(
    path.join(output, logName),
    `${result.stdout || ""}${result.stderr || ""}`,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, `See ${path.join(output, logName)}`);
  return result;
}
for (const version of ["0.7.0-beta.1", "0.7.0"]) {
  const fixture = fs.mkdtempSync(path.join(output, `${version}-`));
  const tauri = path.join(fixture, "src-tauri");
  fs.mkdirSync(path.join(tauri, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(tauri, "Cargo.toml"),
    `[package]\nname = "rpm-smoke"\nversion = "${version}"\nedition = "2021"\nlicense = "MPL-2.0"\ndescription = "RPM packaging smoke fixture"\n`,
  );
  fs.writeFileSync(
    path.join(tauri, "src/main.rs"),
    'fn main() { println!("rpm fixture"); }\n',
  );
  fs.writeFileSync(
    path.join(tauri, "tauri.conf.json"),
    JSON.stringify(
      {
        productName: "RpmSmoke",
        identifier: "run.rosie.rpm-smoke",
        version,
        bundle: {
          active: true,
          targets: ["rpm"],
          icon: [],
          createUpdaterArtifacts: false,
        },
      },
      null,
      2,
    ),
  );
  try {
    run(
      "cargo",
      ["build", "--release", "--offline"],
      tauri,
      `${version}-compile.log`,
    );
    run(
      process.execPath,
      [cli, "bundle", "--bundles", "rpm", "--no-binary-patching"],
      fixture,
      `${version}-bundle.log`,
    );
    const bundleDir = path.join(tauri, "target/release/bundle/rpm");
    const rpmNames = fs
      .readdirSync(bundleDir)
      .filter((name) => name.endsWith(".rpm"));
    assert.equal(rpmNames.length, 1);
    assert.ok(
      rpmNames[0].includes(version),
      "artifact must retain the application version",
    );
    const rpm = path.join(bundleDir, rpmNames[0]);
    const bytes = fs.readFileSync(rpm);
    assert.equal(
      bytes.subarray(0, 4).toString("hex"),
      "edabeedb",
      "RPM lead magic",
    );
    results.push({
      version,
      status: "passed",
      rpm,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  } catch (error) {
    results.push({ version, status: "failed", error: String(error) });
    throw error;
  } finally {
    fs.writeFileSync(
      path.join(output, "result.json"),
      JSON.stringify(results, null, 2) + "\n",
    );
  }
}
console.log(
  `RPM packaging passed. Evidence: ${path.join(output, "result.json")}`,
);
