"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertReleaseBranchProtection,
  configureReleaseBranchProtection,
  desiredProtection,
  requiredStatusCheckNames,
} = require("./release-branch-protection.cjs");

test("requiredStatusCheckNames supports checks and legacy contexts", () => {
  const names = requiredStatusCheckNames({
    required_status_checks: {
      checks: [{ context: "quality-gate" }],
      contexts: ["legacy-check"],
    },
  });
  assert.deepEqual([...names].sort(), ["legacy-check", "quality-gate"]);
});

test("release branch protection requires a strict quality-gate", () => {
  const calls = [];
  const api = (method, endpoint) => {
    calls.push([method, endpoint]);
    return {
      required_status_checks: {
        strict: true,
        checks: [{ context: "quality-gate" }],
      },
    };
  };
  assert.doesNotThrow(() =>
    assertReleaseBranchProtection("beta", { api, env: {} }),
  );
  assert.deepEqual(calls, [
    ["GET", "/repos/BurntToasters/zinnia/branches/beta/protection"],
  ]);
});

test("unprotected release branches fail closed", () => {
  const api = () => {
    const error = new Error("HTTP 404");
    error.statusCode = 404;
    throw error;
  };
  assert.throws(
    () => assertReleaseBranchProtection("main", { api, env: {} }),
    /main is not protected/,
  );
});

test("configure applies the same fail-closed policy to beta and main", () => {
  const writes = [];
  const api = (method, endpoint, body) => {
    if (method === "PUT") {
      writes.push([endpoint, body]);
      return {};
    }
    return {
      required_status_checks: {
        strict: true,
        contexts: ["quality-gate"],
      },
    };
  };
  configureReleaseBranchProtection({ api, env: {} });
  assert.equal(writes.length, 2);
  assert.deepEqual(
    writes.map((entry) => entry[0]),
    [
      "/repos/BurntToasters/zinnia/branches/beta/protection",
      "/repos/BurntToasters/zinnia/branches/main/protection",
    ],
  );
  assert.deepEqual(writes[0][1], desiredProtection());
});
