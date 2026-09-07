"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  REQUIRED_CHECK_APP_ID,
  assertReleaseBranchProtection,
  configureReleaseBranchProtection,
  desiredProtection,
  requiredStatusCheckNames,
} = require("./release-branch-protection.cjs");

function protectedResponse(overrides = {}) {
  return {
    required_status_checks: {
      strict: true,
      checks: [{ context: "ci-gate", app_id: REQUIRED_CHECK_APP_ID }],
    },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    ...overrides,
  };
}

test("requiredStatusCheckNames supports checks and legacy contexts", () => {
  const names = requiredStatusCheckNames({
    required_status_checks: {
      checks: [{ context: "quality-gate" }],
      contexts: ["legacy-check"],
    },
  });
  assert.deepEqual([...names].sort(), ["legacy-check", "quality-gate"]);
});

test("release branch protection requires a strict source-bound ci-gate", () => {
  const calls = [];
  const api = (method, endpoint) => {
    calls.push([method, endpoint]);
    return protectedResponse();
  };
  assert.doesNotThrow(() =>
    assertReleaseBranchProtection("beta", { api, env: {} }),
  );
  assert.deepEqual(calls, [
    ["GET", "/repos/BurntToasters/zinnia/branches/beta/protection"],
  ]);
});

test("release branch protection rejects weakened safety controls", () => {
  const responses = [
    protectedResponse({ enforce_admins: { enabled: false } }),
    protectedResponse({ allow_force_pushes: { enabled: true } }),
    protectedResponse({ allow_deletions: { enabled: true } }),
    protectedResponse({
      required_status_checks: {
        strict: true,
        checks: [{ context: "ci-gate", app_id: 1 }],
      },
    }),
  ];
  for (const response of responses) {
    assert.throws(() =>
      assertReleaseBranchProtection("beta", {
        api: () => response,
        env: {},
      }),
    );
  }
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
    return protectedResponse();
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

test("CI gate aggregates every independent proof check", () => {
  const workflow = require("node:fs").readFileSync(
    require("node:path").join(
      __dirname,
      "..",
      ".github",
      "workflows",
      "ci.yml",
    ),
    "utf8",
  );
  assert.match(workflow, /^  ci-gate:\r?$/m);
  assert.match(workflow, /^    if: \$\{\{ always\(\) \}\}\r?$/m);
  for (const job of [
    "commit-message-policy",
    "quality-gate",
    "rust-check",
    "updater-manifest",
    "smoke-build",
    "security-audit",
  ]) {
    assert.match(workflow, new RegExp(`^      - ${job}\\r?$`, "m"));
  }
});

test("CI avoids duplicate PR branch runs and duplicate Ubuntu checks", () => {
  const workflow = require("node:fs").readFileSync(
    require("node:path").join(
      __dirname,
      "..",
      ".github",
      "workflows",
      "ci.yml",
    ),
    "utf8",
  );
  assert.match(
    workflow,
    /^on:\r?\n  push:\r?\n    branches: \[main, beta\]\r?\n  pull_request:\r?\n    branches: \[main, beta\]$/m,
  );

  const qualityJob = workflow.match(
    /^  quality-gate:\r?\n[\s\S]*?(?=^  [a-z][a-z-]+:\r?$)/m,
  )?.[0];
  const securityJob = workflow.match(
    /^  security-audit:\r?\n[\s\S]*?(?=^  [a-z][a-z-]+:\r?$)/m,
  )?.[0];
  assert.ok(qualityJob);
  assert.ok(securityJob);
  for (const duplicate of [
    "npm audit signatures",
    "npm audit --omit=dev --audit-level=high",
    "npm run audit:dev-reviewed",
    "npm run check:rustsec-ignore-policy",
  ]) {
    assert.doesNotMatch(
      qualityJob,
      new RegExp(duplicate.replaceAll(":", "\\:")),
    );
    assert.match(securityJob, new RegExp(duplicate.replaceAll(":", "\\:")));
  }
  assert.match(qualityJob, /npm run test:all/);
  assert.doesNotMatch(securityJob, /cargo clippy/);
});

test("CI is limited to tests, audits, validation, and unsigned smoke builds", () => {
  const workflow = require("node:fs").readFileSync(
    require("node:path").join(
      __dirname,
      "..",
      ".github",
      "workflows",
      "ci.yml",
    ),
    "utf8",
  );
  assert.doesNotMatch(workflow, /^\s*(?:-\s*)?(?:run:\s*)?npm run release:/m);
  for (const line of workflow.split(/\r?\n/)) {
    if (line.includes("npx tauri build")) {
      assert.match(line, /--no-bundle\s*$/);
    }
  }
});
