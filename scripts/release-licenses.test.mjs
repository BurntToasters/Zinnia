import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_LICENSE_SCRIPTS,
  runReleaseLicenses,
} from "./release-licenses.js";

const require = createRequire(import.meta.url);
const { npmInvocation } = require("./npm-cli.cjs");

test("every release generates strict Cargo license notices", () => {
  assert.deepEqual(RELEASE_LICENSE_SCRIPTS, [
    "licenses:npm",
    "licenses:cargo:strict",
    "licenses:7zip",
  ]);
});

test("Windows npm scripts run through the active npm CLI without a shell", () => {
  assert.deepEqual(
    npmInvocation({
      env: { npm_execpath: "C:\\npm\\npm-cli.js" },
      platform: "win32",
      execPath: "C:\\node\\node.exe",
    }),
    {
      command: "C:\\node\\node.exe",
      prefixArgs: ["C:\\npm\\npm-cli.js"],
    },
  );

  const calls = [];
  const status = runReleaseLicenses({
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    env: { npm_execpath: "C:\\npm\\npm-cli.js" },
    platform: "win32",
    execPath: "C:\\node\\node.exe",
    cwd: "C:\\repo",
  });
  assert.equal(status, 0);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.options.shell === false));
  assert.deepEqual(
    calls.map((call) => call.args),
    RELEASE_LICENSE_SCRIPTS.map((script) => [
      "C:\\npm\\npm-cli.js",
      "run",
      script,
    ]),
  );
});

test("Windows npm invocation fails closed without the active npm CLI", () => {
  assert.throws(
    () => npmInvocation({ env: {}, platform: "win32" }),
    /run this command through npm/,
  );
});

test(
  "Windows release licenses resolve Node through real nested npm lifecycle shells",
  { skip: process.platform !== "win32" },
  () => {
    const root = fileURLToPath(
      new URL("../coverage/windows-release-node-path/", import.meta.url),
    );
    mkdirSync(root, { recursive: true });
    const fixture = mkdtempSync(path.join(root, "fixture with spaces-"));
    const npmCli =
      process.env.npm_execpath ||
      path.join(
        path.dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
    assert.ok(existsSync(npmCli), "the active npm CLI must exist");
    writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({
        private: true,
        scripts: Object.fromEntries(
          RELEASE_LICENSE_SCRIPTS.map((script) => [
            script,
            `node probe.cjs ${script}`,
          ]),
        ),
      }),
    );
    writeFileSync(
      path.join(fixture, "probe.cjs"),
      `
    const fs = require("node:fs");
    fs.appendFileSync("calls.jsonl", JSON.stringify({script: process.argv[2], node: process.execPath, marker: process.env.ZINNIA_PATH_PROBE}) + "\\n");
    if (process.argv[2] === process.env.ZINNIA_FAIL_LICENSE_STEP) process.exit(7);
  `,
    );
    const systemPath = path.join(process.env.SystemRoot, "System32");
    const cases = [
      { Path: systemPath },
      { PATH: systemPath },
      { PATH: systemPath, Path: fixture },
      {},
      { Path: systemPath, ZINNIA_FAIL_LICENSE_STEP: "licenses:cargo:strict" },
    ];
    const results = [];
    for (const [index, paths] of cases.entries()) {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key.toLowerCase() !== "path",
        ),
      );
      Object.assign(env, paths, {
        npm_execpath: npmCli,
        ZINNIA_PATH_PROBE: "preserved",
      });
      const original = { ...env };
      writeFileSync(path.join(fixture, "calls.jsonl"), "");
      const status = runReleaseLicenses({
        env,
        cwd: fixture,
        spawn(command, args, options) {
          const pathKeys = Object.keys(options.env).filter(
            (key) => key.toLowerCase() === "path",
          );
          assert.equal(
            pathKeys.length,
            1,
            "child must have one unambiguous PATH",
          );
          const entries = options.env[pathKeys[0]].split(";");
          assert.ok(entries.includes(path.dirname(process.execPath)));
          for (const [key, value] of Object.entries(paths)) {
            if (key.toLowerCase() === "path")
              assert.ok(entries.includes(value));
          }
          const result = spawnSync(command, args, {
            ...options,
            stdio: "pipe",
            encoding: "utf8",
          });
          writeFileSync(
            path.join(
              fixture,
              `case-${index}-${args.at(-1).replaceAll(":", "-")}.log`,
            ),
            `${result.stdout || ""}${result.stderr || ""}`,
          );
          return result;
        },
      });
      const calls = readFileSync(path.join(fixture, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      results.push({ paths, status, calls });
      writeFileSync(
        path.join(root, "result.json"),
        JSON.stringify({ fixture, results }, null, 2),
      );
      const expectedStatus = env.ZINNIA_FAIL_LICENSE_STEP ? 7 : 0;
      assert.equal(
        status,
        expectedStatus,
        `case ${index}: see logs in ${fixture}`,
      );
      assert.deepEqual(
        calls.map((call) => call.script),
        expectedStatus
          ? RELEASE_LICENSE_SCRIPTS.slice(0, 2)
          : RELEASE_LICENSE_SCRIPTS,
      );
      assert.ok(
        calls.every(
          (call) =>
            call.node === process.execPath && call.marker === "preserved",
        ),
      );
      assert.deepEqual(env, original, "parent environment must be unchanged");
    }
  },
);

test("license failures stop before later scripts and preserve POSIX environments", () => {
  const env = { PATH: "/tools:/usr/bin", ZINNIA_PATH_PROBE: "preserved" };
  const calls = [];
  const status = runReleaseLicenses({
    env,
    platform: "linux",
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: calls.length === 2 ? 7 : 0 };
    },
  });
  assert.equal(status, 7);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["run", "licenses:npm"],
      ["run", "licenses:cargo:strict"],
    ],
  );
  assert.ok(
    calls.every((call) => call.command === "npm" && call.options.env === env),
  );
});
