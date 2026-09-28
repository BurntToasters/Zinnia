"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BETA_TAG_RULESET_NAME,
  REQUIRED_CHECK_APP_ID,
  assertBetaTagProtection,
  assertBetaTagRulesetResponse,
  assertReleaseBranchProtection,
  assertSuccessfulHostedCi,
  configureBetaTagProtection,
  configureReleaseBranchProtection,
  desiredBetaTagRuleset,
  desiredProtection,
  betaTagRulesetListEndpoint,
  betaTagRulesetEndpoint,
  requiredStatusCheckNames,
} = require("./release-branch-protection.cjs");

function protectedResponse(overrides = {}) {
  return {
    required_status_checks: {
      strict: true,
      checks: [
        { context: "ci-gate", app_id: REQUIRED_CHECK_APP_ID },
        { context: "release-policy", app_id: REQUIRED_CHECK_APP_ID },
      ],
    },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      required_approving_review_count: 1,
      require_last_push_approval: true,
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    ...overrides,
  };
}

function immutableBetaTagRuleset(overrides = {}) {
  return {
    id: 17,
    name: BETA_TAG_RULESET_NAME,
    source_type: "Repository",
    target: "tag",
    enforcement: "active",
    bypass_actors: [],
    conditions: {
      ref_name: {
        include: ["refs/tags/v*-beta.*"],
        exclude: [],
      },
    },
    rules: [{ type: "update" }, { type: "deletion" }],
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

test("stable release protection requires strict source-bound CI and policy checks", () => {
  const calls = [];
  const api = (method, endpoint) => {
    calls.push([method, endpoint]);
    return protectedResponse();
  };
  assert.doesNotThrow(() =>
    assertReleaseBranchProtection("main", { api, env: {} }),
  );
  assert.deepEqual(calls, [
    ["GET", "/repos/BurntToasters/zinnia/branches/main/protection"],
  ]);
});

test("beta releases permit an unprotected and deletable staging branch", () => {
  let called = false;
  const api = () => {
    called = true;
    throw new Error("beta protection must not be queried");
  };
  assert.equal(assertReleaseBranchProtection("beta", { api, env: {} }), null);
  assert.equal(called, false);
});

test("stable release branch protection rejects weakened safety controls", () => {
  const responses = [
    protectedResponse({ allow_force_pushes: { enabled: true } }),
    protectedResponse({ allow_deletions: { enabled: true } }),
    protectedResponse({
      required_status_checks: {
        strict: true,
        checks: [{ context: "ci-gate", app_id: 1 }],
      },
    }),
    protectedResponse({
      required_status_checks: {
        strict: true,
        checks: [{ context: "ci-gate", app_id: REQUIRED_CHECK_APP_ID }],
      },
    }),
    protectedResponse({
      required_status_checks: {
        strict: true,
        checks: [
          { context: "ci-gate", app_id: REQUIRED_CHECK_APP_ID },
          { context: "release-policy", app_id: 1 },
        ],
      },
    }),
  ];
  for (const response of responses) {
    assert.throws(() =>
      assertReleaseBranchProtection("main", {
        api: () => response,
        env: {},
      }),
    );
  }
});

test("main requires independent review and enforces rules for administrators", () => {
  for (const protection of [
    protectedResponse({ enforce_admins: { enabled: false } }),
    protectedResponse({ required_pull_request_reviews: null }),
    protectedResponse({
      required_pull_request_reviews: {
        dismiss_stale_reviews: false,
        required_approving_review_count: 1,
        require_last_push_approval: true,
      },
    }),
    protectedResponse({
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        required_approving_review_count: 0,
        require_last_push_approval: true,
      },
    }),
    protectedResponse({
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        required_approving_review_count: 1,
        require_last_push_approval: false,
      },
    }),
    protectedResponse({
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        required_approving_review_count: 1,
        require_last_push_approval: true,
        bypass_pull_request_allowances: {
          users: ["labeler"],
          teams: [],
          apps: [],
        },
      },
    }),
  ]) {
    assert.throws(() =>
      assertReleaseBranchProtection("main", {
        api: () => protection,
        env: {},
      }),
    );
  }
  assert.doesNotThrow(() =>
    assertReleaseBranchProtection("main", {
      api: () => protectedResponse(),
      env: {},
    }),
  );
  assert.equal(desiredProtection().enforce_admins, true);
  assert.deepEqual(desiredProtection().required_pull_request_reviews, {
    dismiss_stale_reviews: true,
    required_approving_review_count: 1,
    require_last_push_approval: true,
  });
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

test("configure protects main and installs immutable beta tag rules", () => {
  const writes = [];
  let ruleset = null;
  const api = (method, endpoint, body) => {
    if (endpoint.includes("/branches/main/protection") && method === "PUT") {
      writes.push([endpoint, body]);
      return {};
    }
    if (endpoint.includes("/branches/main/protection")) {
      return protectedResponse();
    }
    if (endpoint === betaTagRulesetListEndpoint({})) {
      return ruleset ? [{ id: ruleset.id, name: ruleset.name }] : [];
    }
    if (endpoint.endsWith("/rulesets") && method === "POST") {
      ruleset = { ...body, id: 17, source_type: "Repository" };
      writes.push([endpoint, body]);
      return ruleset;
    }
    if (endpoint === betaTagRulesetEndpoint(17, {})) return ruleset;
    throw new Error(`Unexpected API call: ${method} ${endpoint}`);
  };
  configureReleaseBranchProtection({ api, env: {} });
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], [
    "/repos/BurntToasters/zinnia/branches/main/protection",
    desiredProtection(),
  ]);
  assert.deepEqual(writes[1], [
    "/repos/BurntToasters/zinnia/rulesets",
    desiredBetaTagRuleset(),
  ]);
});

// Tag-governance failures to prevent before implementation:
// - the ruleset is missing, disabled, aimed at branches, or covers another tag pattern;
// - updates or deletions remain possible, or any bypass actor can rewrite an accepted tag;
// - setup silently skips ruleset creation or reports success before re-reading the saved rule.
test("beta tag ruleset must be active, exact, immutable, and bypass-free", () => {
  assert.doesNotThrow(() =>
    assertBetaTagRulesetResponse(immutableBetaTagRuleset()),
  );
  const invalid = [
    immutableBetaTagRuleset({ enforcement: "disabled" }),
    immutableBetaTagRuleset({ target: "branch" }),
    immutableBetaTagRuleset({
      conditions: { ref_name: { include: ["refs/tags/*"], exclude: [] } },
    }),
    immutableBetaTagRuleset({ rules: [{ type: "deletion" }] }),
    immutableBetaTagRuleset({ rules: [{ type: "update" }] }),
    immutableBetaTagRuleset({
      rules: [{ type: "update" }, { type: "deletion" }, { type: "creation" }],
    }),
    immutableBetaTagRuleset({
      bypass_actors: [
        { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
      ],
    }),
    immutableBetaTagRuleset({ source_type: "Organization" }),
  ];
  for (const ruleset of invalid) {
    assert.throws(() => assertBetaTagRulesetResponse(ruleset));
  }
  assert.throws(
    () =>
      assertBetaTagRulesetResponse({
        ...immutableBetaTagRuleset(),
        bypass_actors: undefined,
      }),
    /bypass actors/,
  );
});

test("beta tag protection fails closed when the repository ruleset is missing", () => {
  assert.throws(
    () => assertBetaTagProtection({ api: () => [], env: {} }),
    /beta tag ruleset is missing/,
  );
});

test("beta tag protection reads saved ruleset details and rejects duplicates", () => {
  const calls = [];
  const ruleset = immutableBetaTagRuleset();
  const api = (_method, endpoint) => {
    calls.push(endpoint);
    if (endpoint === betaTagRulesetListEndpoint({})) {
      return [{ id: ruleset.id, name: ruleset.name }];
    }
    return ruleset;
  };
  assert.deepEqual(assertBetaTagProtection({ api, env: {} }), ruleset);
  assert.deepEqual(calls, [
    betaTagRulesetListEndpoint({}),
    betaTagRulesetEndpoint(ruleset.id, {}),
  ]);
  assert.throws(
    () =>
      assertBetaTagProtection({
        api: () => [
          { id: 17, name: BETA_TAG_RULESET_NAME },
          { id: 18, name: BETA_TAG_RULESET_NAME },
        ],
        env: {},
      }),
    /exactly one/,
  );
});

// Ruleset pagination failures to prevent before implementation:
// - a duplicate managed ruleset exists beyond the first page and is missed;
// - setup or preflight stops early without proving the full list was read;
// - an API page fails or returns malformed data and is treated as an empty page.
test("beta tag protection scans every ruleset page before accepting uniqueness", () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 100,
    name: `unmanaged-${index}`,
  }));
  const ruleset = immutableBetaTagRuleset();
  firstPage[99] = { id: ruleset.id, name: ruleset.name };
  const api = (_method, endpoint) => {
    calls.push(endpoint);
    if (endpoint === betaTagRulesetListEndpoint({}, 1)) return firstPage;
    if (endpoint === betaTagRulesetListEndpoint({}, 2)) {
      return [{ id: 18, name: BETA_TAG_RULESET_NAME }];
    }
    if (endpoint === betaTagRulesetEndpoint(ruleset.id, {})) return ruleset;
    throw new Error(`Unexpected API request: ${endpoint}`);
  };
  assert.throws(() => assertBetaTagProtection({ api, env: {} }), /exactly one/);
  assert.deepEqual(calls, [
    betaTagRulesetListEndpoint({}, 1),
    betaTagRulesetListEndpoint({}, 2),
  ]);

  const writes = [];
  assert.throws(
    () =>
      configureBetaTagProtection({
        env: {},
        api: (method, endpoint) => {
          if (method !== "GET") writes.push([method, endpoint]);
          if (endpoint === betaTagRulesetListEndpoint({}, 1)) return firstPage;
          if (endpoint === betaTagRulesetListEndpoint({}, 2)) {
            return [{ id: 18, name: BETA_TAG_RULESET_NAME }];
          }
          throw new Error(`Unexpected API request: ${endpoint}`);
        },
      }),
    /exactly one/,
  );
  assert.deepEqual(writes, []);
});

test("beta tag protection creates or repairs ruleset, then verifies persisted settings", () => {
  let saved = null;
  const writes = [];
  const api = (method, endpoint, body) => {
    if (endpoint === betaTagRulesetListEndpoint({})) {
      return saved ? [{ id: saved.id, name: saved.name }] : [];
    }
    if (method === "POST" && endpoint.endsWith("/rulesets")) {
      writes.push([method, endpoint, body]);
      saved = { ...body, id: 22, source_type: "Repository" };
      return saved;
    }
    if (method === "PUT" && endpoint === betaTagRulesetEndpoint(22, {})) {
      writes.push([method, endpoint, body]);
      saved = { ...body, id: 22, source_type: "Repository" };
      return saved;
    }
    if (endpoint === betaTagRulesetEndpoint(22, {})) return saved;
    throw new Error(`Unexpected API call: ${method} ${endpoint}`);
  };
  configureBetaTagProtection({ api, env: {} });
  assert.deepEqual(writes, [
    ["POST", "/repos/BurntToasters/zinnia/rulesets", desiredBetaTagRuleset()],
  ]);
  configureBetaTagProtection({ api, env: {} });
  assert.deepEqual(writes[1], [
    "PUT",
    "/repos/BurntToasters/zinnia/rulesets/22",
    desiredBetaTagRuleset(),
  ]);
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
    "node scripts/npm-audit-signatures.cjs",
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

test("stable runbook promotes the next branch directly to main", () => {
  const runbook = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "docs", "RELEASE-STABLE.md"),
    "utf8",
  );
  assert.match(runbook, /git switch next-X\.Y\.Z/);
  assert.match(
    runbook,
    /promotion pull request from `next-X\.Y\.Z` directly to `main`/,
  );
  assert.match(runbook, /Do not merge it through `beta` first/);
  assert.doesNotMatch(runbook, /git switch beta/);
  assert.doesNotMatch(runbook, /accepted `beta` tip/);
  assert.doesNotMatch(
    runbook,
    /\bv?\d+\.\d+\.\d+(?:-beta\.\d+)?\b/,
    "the reusable runbook must not encode a concrete release version",
  );
  assert.doesNotMatch(runbook, /npm run u/);
  assert.match(runbook, /Edit `package\.json`/);
  assert.match(runbook, /npm run sync-version/);
  assert.match(runbook, /node scripts\/update-metainfo\.js/);
});

// Release proof failures to prevent before implementation:
// - a pushed HEAD has no hosted CI run, or only a PR check from another ref;
// - a prior green run masks a newer red, cancelled, or pending run;
// - a green workflow lacks a successful ci-gate from the expected Actions app;
// - the check belongs to another commit or check suite;
// - a beta or stable release proceeds after an administrator bypasses CI.
test("release preflight requires the latest exact-HEAD hosted push ci-gate", () => {
  const sha = "a".repeat(40);
  const run = {
    id: 42,
    head_sha: sha,
    head_branch: "main",
    event: "push",
    path: ".github/workflows/ci.yml@main",
    check_suite_id: 84,
    status: "completed",
    conclusion: "success",
    created_at: "2026-09-27T12:00:00Z",
  };
  const check = {
    id: 77,
    name: "ci-gate",
    head_sha: sha,
    check_suite: { id: 84 },
    app: { id: REQUIRED_CHECK_APP_ID },
    status: "completed",
    conclusion: "success",
  };
  const gateJob = {
    id: 78,
    run_id: run.id,
    name: "ci-gate",
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    check_run_url:
      "https://api.github.com/repos/BurntToasters/zinnia/check-runs/77",
  };
  const api = (_method, endpoint) => {
    if (endpoint.includes("/actions/workflows/")) {
      return { workflow_runs: [run] };
    }
    if (endpoint.includes(`/actions/runs/${run.id}/jobs?`)) {
      return { total_count: 1, jobs: [gateJob] };
    }
    return { check_runs: [check] };
  };
  assert.doesNotThrow(() =>
    assertSuccessfulHostedCi("main", sha, { api, env: {} }),
  );
  assert.throws(
    () =>
      assertSuccessfulHostedCi("main", sha, {
        api: (_method, endpoint) =>
          endpoint.includes("/actions/workflows/")
            ? { workflow_runs: [] }
            : { check_runs: [check] },
        env: {},
      }),
    /no hosted push CI run/,
  );
  for (const broken of [
    { ...run, id: 0 },
    { ...run, head_sha: "b".repeat(40) },
    { ...run, head_branch: "beta" },
    { ...run, event: "pull_request" },
    { ...run, path: ".github/workflows/other.yml@main" },
    { ...run, path: ".github/workflows/ci.yml@beta" },
    { ...run, check_suite_id: 85 },
    { ...run, conclusion: "failure" },
    { ...run, status: "in_progress", conclusion: null },
  ]) {
    assert.throws(() =>
      assertSuccessfulHostedCi("main", sha, {
        api: (_method, endpoint) =>
          endpoint.includes("/actions/workflows/")
            ? { workflow_runs: [broken] }
            : { check_runs: [check] },
        env: {},
      }),
    );
  }
  for (const brokenJob of [
    { ...gateJob, run_id: 43 },
    { ...gateJob, name: "other-job" },
    { ...gateJob, head_sha: "b".repeat(40) },
    { ...gateJob, status: "in_progress", conclusion: null },
    { ...gateJob, conclusion: "failure" },
    { ...gateJob, check_run_url: "https://api.github.com/check-runs/0" },
  ]) {
    assert.throws(() =>
      assertSuccessfulHostedCi("main", sha, {
        api: (_method, endpoint) =>
          endpoint.includes("/actions/workflows/")
            ? { workflow_runs: [run] }
            : endpoint.includes(`/actions/runs/${run.id}/jobs?`)
              ? { total_count: 1, jobs: [brokenJob] }
              : { check_runs: [check] },
        env: {},
      }),
    );
  }
  assert.throws(() =>
    assertSuccessfulHostedCi("main", sha, {
      api: (_method, endpoint) =>
        endpoint.includes("/actions/workflows/")
          ? { workflow_runs: [run] }
          : endpoint.includes(`/actions/runs/${run.id}/jobs?`)
            ? {
                total_count: 2,
                jobs: [gateJob, { ...gateJob, id: 79 }],
              }
            : { check_runs: [check] },
      env: {},
    }),
  );
  for (const broken of [
    { ...check, head_sha: "b".repeat(40) },
    { ...check, check_suite: { id: 85 } },
    { ...check, app: { id: 1 } },
    { ...check, conclusion: "failure" },
  ]) {
    assert.throws(() =>
      assertSuccessfulHostedCi("main", sha, {
        api: (_method, endpoint) =>
          endpoint.includes("/actions/workflows/")
            ? { workflow_runs: [run] }
            : endpoint.includes(`/actions/runs/${run.id}/jobs?`)
              ? { total_count: 1, jobs: [gateJob] }
              : { check_runs: [broken] },
        env: {},
      }),
    );
  }
  assert.throws(
    () =>
      assertSuccessfulHostedCi("main", sha, {
        api: (_method, endpoint) =>
          endpoint.includes("/actions/workflows/")
            ? { workflow_runs: [run] }
            : endpoint.includes(`/actions/runs/${run.id}/jobs?`)
              ? { total_count: 1, jobs: [gateJob] }
              : {
                  check_runs: [check, { ...check, id: 45, app: { id: 1 } }],
                },
        env: {},
      }),
    /unique successful GitHub Actions ci-gate/,
  );
  assert.throws(() =>
    assertSuccessfulHostedCi("main", sha, {
      api: (_method, endpoint) =>
        endpoint.includes("/actions/workflows/")
          ? {
              workflow_runs: [
                {
                  ...run,
                  id: 43,
                  conclusion: "failure",
                  created_at: "2026-09-27T13:00:00Z",
                },
                run,
              ],
            }
          : endpoint.includes(`/actions/runs/${run.id}/jobs?`)
            ? { total_count: 1, jobs: [gateJob] }
            : { check_runs: [check] },
      env: {},
    }),
  );
});

// Promotion policy failures to prevent before implementation:
// - a next-* name does not match the candidate's numeric version;
// - PR authors select an old beta by editing package.json;
// - an accepted-beta label does not pin the tag commit;
// - a tag points at another package version;
// - a source, workflow, dependency, or build file changes after the beta;
// - tests or docs are deleted to hide regressions;
// - release-policy executes PR-controlled scripts or checks out PR code.
test("base-owned promotion policy binds branch, accepted beta, and source tree", async () => {
  const { validatePromotionCandidate } =
    await import("./release-promotion-policy.mjs");
  const betaSha = "b".repeat(40);
  const candidate = {
    headRef: "next-0.6.3",
    headVersion: "0.6.3-beta.3",
    headRepository: "BurntToasters/zinnia",
    baseRepository: "BurntToasters/zinnia",
    labels: [
      {
        name: "accepted-beta:v0.6.3-beta.3",
        description: `sha=${betaSha}`,
      },
    ],
    betaSha,
    taggedVersion: "0.6.3-beta.3",
    tagRuleset: immutableBetaTagRuleset(),
    changedEntries: [
      { status: "M", path: "docs/RELEASE-STABLE.md" },
      { status: "A", path: "src/tests/regression.test.ts" },
    ],
  };
  assert.deepEqual(validatePromotionCandidate(candidate), {
    tag: "v0.6.3-beta.3",
    sha: betaSha,
  });
  for (const changed of [
    { headRef: "next-0.6.4" },
    { headRef: "next-anything" },
    { headVersion: "0.6.3" },
    { headRepository: "attacker/zinnia" },
    { labels: [] },
    {
      labels: [
        { name: "accepted-beta:v0.6.3-beta.2", description: `sha=${betaSha}` },
      ],
    },
    {
      labels: [
        {
          name: "accepted-beta:v0.6.3-beta.3",
          description: `sha=${"c".repeat(40)}`,
        },
      ],
    },
    { betaSha: "c".repeat(40) },
    { taggedVersion: "0.6.3-beta.2" },
    { tagRuleset: null },
    { tagRuleset: immutableBetaTagRuleset({ enforcement: "disabled" }) },
    { changedEntries: [{ status: "M", path: "src-tauri/src/main.rs" }] },
    { changedEntries: [{ status: "M", path: ".github/workflows/ci.yml" }] },
    { changedEntries: [{ status: "M", path: "package-lock.json" }] },
    { changedEntries: [{ status: "D", path: "src/tests/regression.test.ts" }] },
  ]) {
    assert.throws(() =>
      validatePromotionCandidate({ ...candidate, ...changed }),
    );
  }
  assert.deepEqual(
    validatePromotionCandidate({ ...candidate, changedEntries: [] }),
    {
      tag: "v0.6.3-beta.3",
      sha: betaSha,
    },
  );
  for (const malformedSha of ["d".repeat(39), "e".repeat(50)]) {
    assert.throws(
      () =>
        validatePromotionCandidate({
          ...candidate,
          betaSha: malformedSha,
          labels: [
            {
              name: "accepted-beta:v0.6.3-beta.3",
              description: `sha=${malformedSha}`,
            },
          ],
        }),
      /Accepted beta tag must resolve to a commit SHA/,
    );
  }
});

test("final promotion revalidation reads current labels and binds current PR head", async () => {
  const { assertCurrentPromotionPullRequest } =
    await import("./release-promotion-policy.mjs");
  const headSha = "f".repeat(40);
  const betaSha = "b".repeat(40);
  const eventPr = {
    number: 81,
    state: "open",
    base: {
      ref: "main",
      repo: { full_name: "BurntToasters/zinnia" },
    },
    head: {
      ref: "next-0.6.3",
      sha: headSha,
      repo: { full_name: "BurntToasters/zinnia" },
    },
    labels: [
      {
        name: "accepted-beta:v0.6.3-beta.3",
        description: `sha=${betaSha}`,
      },
    ],
  };
  const currentPr = structuredClone(eventPr);

  assert.doesNotThrow(() =>
    assertCurrentPromotionPullRequest(eventPr, currentPr, {
      tag: "v0.6.3-beta.3",
      betaSha,
    }),
  );
  assert.throws(
    () =>
      assertCurrentPromotionPullRequest(
        eventPr,
        { ...currentPr, labels: [] },
        { tag: "v0.6.3-beta.3", betaSha },
      ),
    /accepted-beta:v0\.6\.3-beta\.3/,
  );
  assert.throws(
    () =>
      assertCurrentPromotionPullRequest(
        eventPr,
        { ...currentPr, head: { ...currentPr.head, sha: "a".repeat(40) } },
        { tag: "v0.6.3-beta.3", betaSha },
      ),
    /head changed during policy evaluation/,
  );
});

// Accepted-beta attestation failures to prevent before implementation:
// - the label was applied by an untrusted actor, or actor permissions cannot be read;
// - label history is missing, malformed, or shows removal as the latest action;
// - the exact beta tag has no published non-draft prerelease, or release metadata disagrees;
// - a same-name ci-gate from a PR, another workflow/ref, or a different suite is accepted;
// - the exact beta SHA lacks a latest successful ci-gate from the GitHub Actions app;
// - pagination/API permission failures silently omit label or check evidence;
// - the label is removed/reapplied, PR head moves, or evidence changes during final revalidation.
test("accepted beta attestation requires trusted label provenance, release, and beta CI", async () => {
  const { verifyAcceptedBetaAttestation } =
    await import("./release-promotion-policy.mjs");
  const headSha = "f".repeat(40);
  const betaSha = "b".repeat(40);
  const labelName = "accepted-beta:v0.6.3-beta.3";
  const eventPr = {
    number: 81,
    state: "open",
    base: {
      ref: "main",
      repo: { full_name: "BurntToasters/zinnia" },
    },
    head: {
      ref: "next-0.6.3",
      sha: headSha,
      repo: { full_name: "BurntToasters/zinnia" },
    },
    labels: [{ name: labelName, description: `sha=${betaSha}` }],
  };
  const trustedActor = "maintainer-user";
  const workflowRun = {
    id: 987,
    head_sha: betaSha,
    head_branch: "beta",
    event: "push",
    path: ".github/workflows/ci.yml@beta",
    check_suite_id: 789,
    status: "completed",
    conclusion: "success",
    created_at: "2026-09-01T10:00:00Z",
  };
  const ciGate = {
    id: 456,
    name: "ci-gate",
    head_sha: betaSha,
    status: "completed",
    conclusion: "success",
    started_at: "2026-09-01T11:00:00Z",
    check_suite: { id: 789 },
    app: { id: REQUIRED_CHECK_APP_ID },
  };
  const ciGateJob = {
    id: 457,
    run_id: workflowRun.id,
    name: "ci-gate",
    head_sha: betaSha,
    status: "completed",
    conclusion: "success",
    check_run_url: `https://api.github.com/repos/BurntToasters/zinnia/check-runs/${ciGate.id}`,
  };
  let labelEventId = 101;
  let labelEventAction = "labeled";
  const apiGet = async (endpoint) => {
    if (endpoint === "/repos/BurntToasters/zinnia/pulls/81") {
      return structuredClone(eventPr);
    }
    if (endpoint.startsWith("/repos/BurntToasters/zinnia/issues/81/events?")) {
      return [
        {
          id: labelEventId,
          event: labelEventAction,
          created_at: "2026-09-27T12:00:00Z",
          actor: { login: trustedActor },
          label: { name: labelName },
        },
      ];
    }
    if (
      endpoint ===
      `/repos/BurntToasters/zinnia/collaborators/${trustedActor}/permission`
    ) {
      return {
        permission: "write",
        role_name: "maintain",
        user: { login: trustedActor },
      };
    }
    if (
      endpoint === "/repos/BurntToasters/zinnia/releases/tags/v0.6.3-beta.3"
    ) {
      return {
        id: 123,
        tag_name: "v0.6.3-beta.3",
        draft: false,
        prerelease: true,
        published_at: "2026-09-01T12:00:00Z",
      };
    }
    if (
      endpoint.startsWith(
        "/repos/BurntToasters/zinnia/actions/workflows/ci.yml/runs?",
      )
    ) {
      return {
        total_count: 1,
        workflow_runs: [structuredClone(workflowRun)],
      };
    }
    if (
      endpoint.startsWith(
        `/repos/BurntToasters/zinnia/actions/runs/${workflowRun.id}/jobs?`,
      )
    ) {
      return { total_count: 1, jobs: [structuredClone(ciGateJob)] };
    }
    if (
      endpoint.startsWith(
        "/repos/BurntToasters/zinnia/check-suites/789/check-runs?",
      )
    ) {
      return {
        total_count: 1,
        check_runs: [structuredClone(ciGate)],
      };
    }
    throw new Error(`Unexpected GitHub API request: ${endpoint}`);
  };
  const input = {
    apiGet,
    eventPr,
    owner: "BurntToasters",
    repo: "zinnia",
    tag: "v0.6.3-beta.3",
    betaSha,
  };

  const result = await verifyAcceptedBetaAttestation(input);
  assert.equal(result.tag, "v0.6.3-beta.3");
  assert.equal(result.sha, betaSha);
  assert.equal(result.appliedBy, trustedActor);
  assert.equal(result.ciGateId, ciGate.id);
  assert.equal(result.ciGateJobId, ciGateJob.id);
  assert.equal(result.ciGateSuiteId, workflowRun.check_suite_id);
  assert.equal(result.ciWorkflowRunId, workflowRun.id);

  await assert.rejects(
    verifyAcceptedBetaAttestation({
      ...input,
      apiGet: async (endpoint) => {
        const response = await apiGet(endpoint);
        if (endpoint.endsWith(`/collaborators/${trustedActor}/permission`)) {
          return { ...response, role_name: "write" };
        }
        return response;
      },
    }),
    /maintainer or admin/,
  );
  await assert.rejects(
    verifyAcceptedBetaAttestation({
      ...input,
      apiGet: async (endpoint) =>
        endpoint.startsWith("/repos/BurntToasters/zinnia/issues/81/events?")
          ? []
          : apiGet(endpoint),
    }),
    /label application event/,
  );
  await assert.rejects(
    verifyAcceptedBetaAttestation({
      ...input,
      apiGet: async (endpoint) =>
        endpoint.endsWith(`/collaborators/${trustedActor}/permission`)
          ? Promise.reject(new Error("permission unavailable"))
          : apiGet(endpoint),
    }),
    /permission unavailable/,
  );

  for (const badRelease of [
    null,
    { id: 123, tag_name: "v0.6.3-beta.3", draft: true, prerelease: true },
    {
      id: 123,
      tag_name: "v0.6.3-beta.2",
      draft: false,
      prerelease: true,
      published_at: "2026-09-01T12:00:00Z",
    },
    {
      id: 123,
      tag_name: "v0.6.3-beta.3",
      draft: false,
      prerelease: false,
      published_at: "2026-09-01T12:00:00Z",
    },
  ]) {
    await assert.rejects(
      verifyAcceptedBetaAttestation({
        ...input,
        apiGet: async (endpoint) =>
          endpoint.endsWith("/releases/tags/v0.6.3-beta.3")
            ? badRelease
            : apiGet(endpoint),
      }),
      /published beta prerelease/,
    );
  }

  for (const badRun of [
    null,
    { ...workflowRun, head_sha: "c".repeat(40) },
    { ...workflowRun, head_branch: "next-0.6.3" },
    { ...workflowRun, event: "pull_request" },
    {
      ...workflowRun,
      path: ".github/workflows/untrusted.yml@beta",
    },
    { ...workflowRun, path: ".github/workflows/ci.yml@main" },
    { ...workflowRun, id: 0 },
    { ...workflowRun, check_suite_id: 0 },
    { ...workflowRun, conclusion: "failure" },
    { ...workflowRun, status: "in_progress", conclusion: null },
  ]) {
    await assert.rejects(
      verifyAcceptedBetaAttestation({
        ...input,
        apiGet: async (endpoint) =>
          endpoint.startsWith(
            "/repos/BurntToasters/zinnia/actions/workflows/ci.yml/runs?",
          )
            ? {
                total_count: badRun ? 1 : 0,
                workflow_runs: badRun ? [badRun] : [],
              }
            : apiGet(endpoint),
      }),
      /successful push CI run|successful trusted hosted ci-gate/,
    );
  }

  for (const badCheck of [
    { ...ciGate, head_sha: "c".repeat(40) },
    { ...ciGate, check_suite: { id: 790 } },
    { ...ciGate, app: { id: 1 } },
    { ...ciGate, conclusion: "failure" },
    { ...ciGate, status: "in_progress", conclusion: null },
  ]) {
    await assert.rejects(
      verifyAcceptedBetaAttestation({
        ...input,
        apiGet: async (endpoint) =>
          endpoint.startsWith(
            "/repos/BurntToasters/zinnia/check-suites/789/check-runs?",
          )
            ? { total_count: 1, check_runs: [badCheck] }
            : apiGet(endpoint),
      }),
      /successful trusted hosted ci-gate/,
    );
  }
  for (const badJob of [
    { ...ciGateJob, run_id: 988 },
    { ...ciGateJob, name: "other-job" },
    { ...ciGateJob, head_sha: "c".repeat(40) },
    { ...ciGateJob, status: "in_progress", conclusion: null },
    { ...ciGateJob, conclusion: "failure" },
    { ...ciGateJob, check_run_url: "https://api.github.com/check-runs/0" },
  ]) {
    await assert.rejects(
      verifyAcceptedBetaAttestation({
        ...input,
        apiGet: async (endpoint) =>
          endpoint.startsWith(
            `/repos/BurntToasters/zinnia/actions/runs/${workflowRun.id}/jobs?`,
          )
            ? { total_count: 1, jobs: [badJob] }
            : apiGet(endpoint),
      }),
      /one successful ci-gate job bound to workflow run/,
    );
  }
  await assert.rejects(
    verifyAcceptedBetaAttestation({
      ...input,
      apiGet: async (endpoint) =>
        endpoint.startsWith(
          "/repos/BurntToasters/zinnia/check-suites/789/check-runs?",
        )
          ? {
              total_count: 2,
              check_runs: [ciGate, { ...ciGate, id: 457, app: { id: 1 } }],
            }
          : apiGet(endpoint),
    }),
    /successful trusted hosted ci-gate/,
  );

  await assert.rejects(
    verifyAcceptedBetaAttestation({
      ...input,
      apiGet: async (endpoint) =>
        endpoint.startsWith("/repos/BurntToasters/zinnia/issues/81/events?")
          ? Promise.reject(new Error("events permission unavailable"))
          : apiGet(endpoint),
    }),
    /events permission unavailable/,
  );

  const originalId = labelEventId;
  let eventReads = 0;
  await assert.rejects(
    verifyAcceptedBetaAttestation({
      ...input,
      apiGet: async (endpoint) => {
        if (
          endpoint.startsWith("/repos/BurntToasters/zinnia/issues/81/events?")
        ) {
          eventReads += 1;
          if (eventReads === 2) labelEventId += 1;
        }
        return apiGet(endpoint);
      },
    }),
    /changed during final revalidation/,
  );
  labelEventId = originalId;
  labelEventAction = "unlabeled";
  await assert.rejects(
    verifyAcceptedBetaAttestation(input),
    /label application event/,
  );
});

// Promotion governance failures to prevent before implementation:
// - a duplicate managed ruleset is hidden on a later page;
// - the beta tag changes after final label/release/CI double-reads but before check success.
test("promotion policy paginates rulesets and checks the beta tag after final attestation", async () => {
  const { loadBetaTagRuleset, revalidateAcceptedBetaTagAfterAttestation } =
    await import("./release-promotion-policy.mjs");
  const ruleset = immutableBetaTagRuleset();
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 100,
    name: `unmanaged-${index}`,
  }));
  firstPage[99] = { id: ruleset.id, name: ruleset.name };
  const env = {
    GITHUB_REPOSITORY: "BurntToasters/zinnia",
    GITHUB_TOKEN: "test-token",
  };
  const duplicateCalls = [];
  await assert.rejects(
    loadBetaTagRuleset(async (endpoint) => {
      duplicateCalls.push(endpoint);
      const page = new URLSearchParams(endpoint.split("?")[1]).get("page");
      if (page === "1") {
        return firstPage;
      }
      if (page === "2") {
        return [{ id: 18, name: BETA_TAG_RULESET_NAME }];
      }
      throw new Error(`Unexpected GitHub API request: ${endpoint}`);
    }, env),
    /missing or ambiguous/,
  );
  assert.equal(duplicateCalls.length, 2);

  const betaSha = "b".repeat(40);
  const order = [];
  assert.equal(
    await revalidateAcceptedBetaTagAfterAttestation({
      tag: "v0.6.3-beta.3",
      betaSha,
      version: "0.6.3-beta.3",
      attest: async () => {
        order.push("attestation-double-read");
      },
      resolveTag: async (tag, expectedSha, version) => {
        order.push("resolve-tag");
        assert.equal(tag, "v0.6.3-beta.3");
        assert.equal(expectedSha, betaSha);
        assert.equal(version, "0.6.3-beta.3");
        return betaSha;
      },
    }),
    betaSha,
  );
  assert.deepEqual(order, ["attestation-double-read", "resolve-tag"]);
  await assert.rejects(
    revalidateAcceptedBetaTagAfterAttestation({
      tag: "v0.6.3-beta.3",
      betaSha,
      version: "0.6.3-beta.3",
      attest: async () => order.push("attestation-double-read"),
      resolveTag: async () => "c".repeat(40),
    }),
    /moved from/,
  );
});

test("trusted release policy workflow never runs PR code", () => {
  const workflowText = require("node:fs").readFileSync(
    require("node:path").join(
      __dirname,
      "..",
      ".github",
      "workflows",
      "release-policy.yml",
    ),
    "utf8",
  );
  const yaml = require("yaml");
  const workflow = yaml.parse(workflowText);
  const job = workflow.jobs["evaluate-release-policy"];
  assert.ok(workflowText.includes("pull_request_target:"));
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    "pull-requests": "read",
    actions: "read",
    checks: "write",
  });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.ok(job);
  const startIndex = job.steps.findIndex(
    (step) => step.name === "Start source-bound release-policy check",
  );
  const checkoutIndex = job.steps.findIndex((step) =>
    String(step.uses || "").startsWith("actions/checkout@"),
  );
  const validateIndex = job.steps.findIndex((step) => step.id === "validate");
  const revalidateIndex = job.steps.findIndex(
    (step) => step.id === "final_revalidation",
  );
  const completeIndex = job.steps.findIndex(
    (step) => step.name === "Complete source-bound release-policy check",
  );
  assert.ok(startIndex >= 0 && startIndex < checkoutIndex);
  assert.ok(checkoutIndex < validateIndex && validateIndex < completeIndex);
  assert.equal(revalidateIndex, -1);
  const checkout = job.steps[checkoutIndex];
  assert.equal(checkout.with.ref, "${{ github.event.pull_request.base.sha }}");
  assert.doesNotMatch(JSON.stringify(checkout), /pull_request\.head\.sha/);
  assert.doesNotMatch(workflowText, /npm (?:ci|install|run)/);
  assert.match(String(job.steps[completeIndex].if), /always\(\).*check_run_id/);
  assert.equal(
    job.steps[completeIndex].env.RELEASE_POLICY_OUTCOME,
    "${{ steps.validate.outcome == 'success' && 'success' || 'failure' }}",
  );
  assert.equal(
    job.steps[completeIndex].env.GITHUB_TOKEN,
    "${{ secrets.GITHUB_TOKEN }}",
  );
  const completeScript = job.steps[completeIndex].with.script;
  assert.match(completeScript, /scripts\/release-promotion-policy\.mjs/);
  assert.ok(
    completeScript.indexOf("--revalidate-beta-tag") <
      completeScript.indexOf("github.rest.checks.update"),
    "the final tag re-resolution must precede successful check publication",
  );
});

// Check publication failures to prevent before implementation:
// - the check is attached to the base SHA or fetched PR ref instead of event head SHA;
// - a policy failure leaves the custom check in progress or marks it successful;
// - the API response belongs to a different head SHA or check run;
// - the check is created in a repository other than the PR base repository.
test("release-policy check binds to PR head SHA and publishes policy failure", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const yaml = require("yaml");
  const workflow = yaml.parse(
    fs.readFileSync(
      path.join(__dirname, "..", ".github", "workflows", "release-policy.yml"),
      "utf8",
    ),
  );
  const steps = workflow.jobs["evaluate-release-policy"].steps;
  const start = steps.find(
    (step) => step.name === "Start source-bound release-policy check",
  );
  const complete = steps.find(
    (step) => step.name === "Complete source-bound release-policy check",
  );
  const headSha = "d".repeat(40);
  const pullRequest = {
    number: 81,
    base: {
      ref: "main",
      repo: { full_name: "BurntToasters/zinnia" },
    },
    head: {
      ref: "next-0.6.3",
      sha: headSha,
      repo: { full_name: "BurntToasters/zinnia" },
    },
  };
  const context = {
    repo: { owner: "BurntToasters", repo: "zinnia" },
    payload: { pull_request: pullRequest },
  };
  const outputs = {};
  const calls = [];
  const github = {
    rest: {
      checks: {
        create: async (input) => {
          calls.push(["create", input]);
          return {
            data: {
              id: 421,
              name: "release-policy",
              head_sha: headSha,
              status: "in_progress",
            },
          };
        },
        update: async (input) => {
          calls.push(["update", input]);
          return {
            data: {
              id: 421,
              name: "release-policy",
              head_sha: headSha,
              status: "completed",
              conclusion: input.conclusion,
            },
          };
        },
      },
    },
  };
  const failures = [];
  const core = {
    setOutput: (name, value) => (outputs[name] = value),
    setFailed: (message) => failures.push(message),
  };
  const childRuns = [];
  let childStatus = 0;
  const fakeRequire = (moduleName) => {
    assert.equal(moduleName, "node:child_process");
    return {
      spawnSync: (...args) => {
        childRuns.push(args);
        return {
          status: childStatus,
          stdout: childStatus === 0 ? "revalidated" : "",
          stderr: childStatus === 0 ? "" : "tag moved",
        };
      },
    };
  };
  const process = {
    execPath: "/usr/bin/node",
    env: {
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_SERVER_URL: "https://github.com",
      RELEASE_POLICY_CHECK_RUN_ID: "421",
      RELEASE_POLICY_OUTCOME: "failure",
    },
  };
  async function runGitHubScript(script) {
    const invoke = new Function(
      "github",
      "context",
      "core",
      "process",
      "require",
      `return (async () => {\n${script}\n})();`,
    );
    return invoke(github, context, core, process, fakeRequire);
  }

  assert.match(start.uses, /^actions\/github-script@[0-9a-f]{40}/);
  assert.equal(start.with["github-token"], "${{ secrets.GITHUB_TOKEN }}");
  await runGitHubScript(start.with.script);
  assert.equal(calls[0][0], "create");
  assert.equal(calls[0][1].name, "release-policy");
  assert.equal(calls[0][1].head_sha, headSha);
  assert.equal(calls[0][1].status, "in_progress");
  assert.equal(outputs.check_run_id, "421");
  assert.equal(outputs.head_sha, headSha);

  assert.match(String(complete.if), /always\(\)/);
  assert.equal(complete.with["github-token"], "${{ secrets.GITHUB_TOKEN }}");
  assert.equal(
    complete.env.RELEASE_POLICY_OUTCOME,
    "${{ steps.validate.outcome == 'success' && 'success' || 'failure' }}",
  );
  await runGitHubScript(complete.with.script);
  assert.equal(calls[1][0], "update");
  assert.equal(calls[1][1].check_run_id, 421);
  assert.equal(calls[1][1].status, "completed");
  assert.equal(calls[1][1].conclusion, "failure");
  assert.match(calls[1][1].output.summary, /See the trusted workflow log/);
  assert.equal(
    childRuns.length,
    0,
    "failed validation must skip final promotion checks",
  );

  context.payload.pull_request.base.repo.full_name = "attacker/zinnia";
  await assert.rejects(
    runGitHubScript(start.with.script),
    /unbound pull request/,
  );
  context.payload.pull_request.base.repo.full_name = "BurntToasters/zinnia";
  process.env.RELEASE_POLICY_OUTCOME = "success";
  await runGitHubScript(complete.with.script);
  assert.equal(calls[2][1].conclusion, "success");
  assert.equal(childRuns.length, 1);
  assert.deepEqual(childRuns[0].slice(0, 2), [
    "/usr/bin/node",
    ["scripts/release-promotion-policy.mjs", "--revalidate-beta-tag"],
  ]);
  childStatus = 1;
  await runGitHubScript(complete.with.script);
  assert.equal(calls[3][1].conclusion, "failure");
  assert.match(calls[3][1].output.summary, /tag moved/);
  assert.match(failures.at(-1), /tag moved/);
});
