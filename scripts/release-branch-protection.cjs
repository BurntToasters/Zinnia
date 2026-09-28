#!/usr/bin/env node
"use strict";

const { githubApi, assertGitHubCliAuthenticated } = require("./github-cli.cjs");

const DEFAULT_OWNER = "BurntToasters";
const DEFAULT_REPO = "zinnia";
const REQUIRED_CHECK = "ci-gate";
const REQUIRED_POLICY_CHECK = "release-policy";
const REQUIRED_CHECK_APP_ID = 15368;
const REQUIRED_CHECKS = [REQUIRED_CHECK, REQUIRED_POLICY_CHECK];
const PROTECTED_RELEASE_BRANCHES = ["main"];
const BETA_TAG_RULESET_NAME = "Immutable beta release tags";
const BETA_TAG_RULESET_INCLUDE = "refs/tags/v*-beta.*";
const BETA_TAG_RULESET_RULES = ["update", "deletion"];
const RULESET_PAGE_SIZE = 100;
const RULESET_MAX_PAGES = 1000;

function repositoryTarget(env = process.env) {
  return {
    owner: String(env.GH_REPO_OWNER || DEFAULT_OWNER).trim(),
    repo: String(env.GH_REPO_NAME || DEFAULT_REPO).trim(),
  };
}

function branchProtectionEndpoint(branch, env = process.env) {
  const { owner, repo } = repositoryTarget(env);
  return `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`;
}

function betaTagRulesetListBaseEndpoint(env = process.env) {
  const { owner, repo } = repositoryTarget(env);
  return `/repos/${owner}/${repo}/rulesets?includes_parents=false`;
}

function betaTagRulesetListEndpoint(env = process.env, page = 1) {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error("Repository ruleset page must be a positive integer.");
  }
  return `${betaTagRulesetListBaseEndpoint(env)}&per_page=${RULESET_PAGE_SIZE}&page=${page}`;
}

function betaTagRulesetEndpoint(rulesetId, env = process.env) {
  const { owner, repo } = repositoryTarget(env);
  return `/repos/${owner}/${repo}/rulesets/${encodeURIComponent(rulesetId)}`;
}

function betaTagRulesetMutationEndpoint(rulesetId, env = process.env) {
  return betaTagRulesetEndpoint(rulesetId, env);
}

function betaTagRulesetCollectionEndpoint(env = process.env) {
  const { owner, repo } = repositoryTarget(env);
  return `/repos/${owner}/${repo}/rulesets`;
}

function desiredBetaTagRuleset() {
  return {
    name: BETA_TAG_RULESET_NAME,
    target: "tag",
    enforcement: "active",
    bypass_actors: [],
    conditions: {
      ref_name: {
        include: [BETA_TAG_RULESET_INCLUDE],
        exclude: [],
      },
    },
    rules: BETA_TAG_RULESET_RULES.map((type) => ({ type })),
  };
}

function assertBetaTagRulesetResponse(
  ruleset,
  { requireNoBypassActors = true } = {},
) {
  if (
    !ruleset ||
    ruleset.name !== BETA_TAG_RULESET_NAME ||
    ruleset.source_type !== "Repository" ||
    ruleset.target !== "tag" ||
    ruleset.enforcement !== "active"
  ) {
    throw new Error(
      "Repository beta tag ruleset must be active and target repository tags.",
    );
  }
  if (!Number.isSafeInteger(ruleset.id) || ruleset.id <= 0) {
    throw new Error("Repository beta tag ruleset has no valid ID.");
  }

  const refName = ruleset.conditions?.ref_name;
  if (
    !Array.isArray(refName?.include) ||
    refName.include.length !== 1 ||
    refName.include[0] !== BETA_TAG_RULESET_INCLUDE ||
    !Array.isArray(refName.exclude) ||
    refName.exclude.length !== 0
  ) {
    throw new Error(
      `Repository beta tag ruleset must target only ${BETA_TAG_RULESET_INCLUDE}.`,
    );
  }

  const ruleTypes = Array.isArray(ruleset.rules)
    ? ruleset.rules.map((rule) => String(rule?.type || ""))
    : [];
  if (
    ruleTypes.length !== BETA_TAG_RULESET_RULES.length ||
    BETA_TAG_RULESET_RULES.some((ruleType) => !ruleTypes.includes(ruleType))
  ) {
    throw new Error(
      "Repository beta tag ruleset must contain exactly the update and deletion rules.",
    );
  }

  if (requireNoBypassActors && !Array.isArray(ruleset.bypass_actors)) {
    throw new Error(
      "Repository beta tag ruleset bypass actors cannot be verified; use repository administration credentials.",
    );
  }
  if (
    Array.isArray(ruleset.bypass_actors) &&
    ruleset.bypass_actors.length !== 0
  ) {
    throw new Error(
      "Repository beta tag ruleset must not allow bypass actors to move or delete accepted tags.",
    );
  }
  return ruleset;
}

function repositoryBetaTagRulesetList(api, env) {
  const rulesets = [];
  let complete = false;
  for (let page = 1; page <= RULESET_MAX_PAGES; page += 1) {
    const entries = api("GET", betaTagRulesetListEndpoint(env, page));
    if (!Array.isArray(entries) || entries.length > RULESET_PAGE_SIZE) {
      throw new Error("Could not read complete repository beta tag rulesets.");
    }
    rulesets.push(...entries);
    if (entries.length < RULESET_PAGE_SIZE) {
      complete = true;
      break;
    }
  }
  if (!complete) {
    throw new Error(
      "Repository beta tag ruleset listing exceeded the safe page limit; refusing an incomplete governance check.",
    );
  }
  const matching = rulesets.filter(
    (ruleset) => ruleset?.name === BETA_TAG_RULESET_NAME,
  );
  if (matching.length > 1) {
    throw new Error(
      `Repository must contain exactly one ${BETA_TAG_RULESET_NAME} ruleset.`,
    );
  }
  return matching[0] || null;
}

function assertBetaTagProtection({ api = githubApi, env = process.env } = {}) {
  const summary = repositoryBetaTagRulesetList(api, env);
  if (!summary) {
    throw new Error(
      `Repository beta tag ruleset is missing. Run npm run repo:protect-release-branches with repository admin access before accepting beta tags.`,
    );
  }
  if (!Number.isSafeInteger(summary.id) || summary.id <= 0) {
    throw new Error("Repository beta tag ruleset summary has no valid ID.");
  }
  const detail = api("GET", betaTagRulesetEndpoint(summary.id, env));
  return assertBetaTagRulesetResponse(detail);
}

function configureBetaTagProtection({
  api = githubApi,
  env = process.env,
} = {}) {
  const existing = repositoryBetaTagRulesetList(api, env);
  const body = desiredBetaTagRuleset();
  if (existing) {
    if (!Number.isSafeInteger(existing.id) || existing.id <= 0) {
      throw new Error("Repository beta tag ruleset summary has no valid ID.");
    }
    api("PUT", betaTagRulesetMutationEndpoint(existing.id, env), body);
  } else {
    api("POST", betaTagRulesetCollectionEndpoint(env), body);
  }
  assertBetaTagProtection({ api, env });
  console.log(
    `release-branch-protection: enforced ${BETA_TAG_RULESET_INCLUDE} immutability with no bypass actors`,
  );
}

function requiredStatusCheckNames(protection) {
  const checks = protection?.required_status_checks?.checks;
  const contexts = protection?.required_status_checks?.contexts;
  return new Set(
    [
      ...(Array.isArray(checks)
        ? checks.map((check) => String(check?.context || "").trim())
        : []),
      ...(Array.isArray(contexts)
        ? contexts.map((context) => String(context || "").trim())
        : []),
    ].filter(Boolean),
  );
}

function assertProtectionResponse(branch, protection) {
  if (!protection?.required_status_checks) {
    throw new Error(
      `${branch} is protected but does not require status checks. Require ${REQUIRED_CHECK} before releasing.`,
    );
  }
  if (protection.required_status_checks.strict !== true) {
    throw new Error(
      `${branch} branch protection must require the branch to be up to date before ${REQUIRED_CHECK} can pass.`,
    );
  }
  const names = requiredStatusCheckNames(protection);
  const checks = protection.required_status_checks.checks;
  for (const checkName of REQUIRED_CHECKS) {
    if (!names.has(checkName)) {
      throw new Error(
        `${branch} branch protection does not require ${checkName}.`,
      );
    }
    const requiredCheck = Array.isArray(checks)
      ? checks.find(
          (check) => String(check?.context || "").trim() === checkName,
        )
      : null;
    if (requiredCheck?.app_id !== REQUIRED_CHECK_APP_ID) {
      throw new Error(
        `${branch} branch protection must bind ${checkName} to GitHub Actions app ${REQUIRED_CHECK_APP_ID}.`,
      );
    }
  }
  const reviews = protection.required_pull_request_reviews;
  if (
    !reviews ||
    reviews.dismiss_stale_reviews !== true ||
    !Number.isInteger(reviews.required_approving_review_count) ||
    reviews.required_approving_review_count < 1 ||
    reviews.require_last_push_approval !== true
  ) {
    throw new Error(
      `${branch} branch protection must require one independent approval, dismiss stale approvals, and require approval after the last push.`,
    );
  }
  const reviewBypass = reviews.bypass_pull_request_allowances;
  if (reviewBypass !== undefined && reviewBypass !== null) {
    const actorLists = [
      reviewBypass.users,
      reviewBypass.teams,
      reviewBypass.apps,
    ];
    if (!actorLists.every(Array.isArray)) {
      throw new Error(
        `${branch} branch protection review-bypass actors cannot be verified.`,
      );
    }
    if (actorLists.some((actors) => actors.length > 0)) {
      throw new Error(
        `${branch} branch protection must not allow actors to bypass required pull request reviews.`,
      );
    }
  }
  if (protection.enforce_admins?.enabled !== true) {
    throw new Error(
      `${branch} branch protection must enforce rules for admins.`,
    );
  }
  if (protection.allow_force_pushes?.enabled !== false) {
    throw new Error(`${branch} branch protection must disable force pushes.`);
  }
  if (protection.allow_deletions?.enabled !== false) {
    throw new Error(`${branch} branch protection must disable deletion.`);
  }
  return protection;
}

function assertReleaseBranchProtection(
  branch,
  { api = githubApi, env = process.env } = {},
) {
  // Beta is an intentionally mutable staging branch. Release preparation still
  // requires a clean checkout whose HEAD exactly matches origin/beta, but beta
  // may remain unprotected and deletable. Stable releases keep the strict main
  // branch policy below.
  if (branch === "beta") return null;

  let protection;
  try {
    protection = api("GET", branchProtectionEndpoint(branch, env));
  } catch (error) {
    if (error?.statusCode === 404) {
      const { owner, repo } = repositoryTarget(env);
      throw new Error(
        `${owner}/${repo}:${branch} is not protected. Run npm run repo:protect-release-branches with repository admin access first.`,
      );
    }
    throw error;
  }
  return assertProtectionResponse(branch, protection);
}

function desiredProtection() {
  return {
    required_status_checks: {
      strict: true,
      checks: REQUIRED_CHECKS.map((context) => ({
        context,
        app_id: REQUIRED_CHECK_APP_ID,
      })),
    },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      required_approving_review_count: 1,
      require_last_push_approval: true,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
}

function configureReleaseBranchProtection({
  api = githubApi,
  env = process.env,
} = {}) {
  for (const branch of PROTECTED_RELEASE_BRANCHES) {
    api("PUT", branchProtectionEndpoint(branch, env), desiredProtection());
    assertReleaseBranchProtection(branch, { api, env });
    console.log(
      `release-branch-protection: protected ${repositoryTarget(env).owner}/${repositoryTarget(env).repo}:${branch} with required ${REQUIRED_CHECKS.join(", ")}`,
    );
  }
  configureBetaTagProtection({ api, env });
}

function latestSuccessfulHostedCiRun(workflowRuns, branch, head) {
  if (!["main", "beta"].includes(branch) || !/^[0-9a-f]{40,64}$/i.test(head)) {
    throw new Error(
      "Hosted CI verification needs an exact release branch and commit SHA.",
    );
  }
  const expectedHead = head.toLowerCase();
  const expectedPath = `.github/workflows/ci.yml@${branch}`;
  const exactRuns = Array.isArray(workflowRuns)
    ? workflowRuns.filter(
        (run) =>
          Number.isSafeInteger(run?.id) &&
          run.id > 0 &&
          String(run?.head_sha || "").toLowerCase() === expectedHead &&
          run?.head_branch === branch &&
          run?.event === "push" &&
          run?.path === expectedPath &&
          Number.isSafeInteger(run?.check_suite_id) &&
          run.check_suite_id > 0,
      )
    : [];
  if (exactRuns.length === 0) {
    throw new Error(
      `Release ${branch}@${head.slice(0, 12)} has no hosted push CI run for the exact workflow ref.`,
    );
  }
  exactRuns.sort((a, b) => {
    const dateOrder =
      Date.parse(b.created_at || "") - Date.parse(a.created_at || "");
    return Number.isFinite(dateOrder) && dateOrder !== 0
      ? dateOrder
      : Number(b.id || 0) - Number(a.id || 0);
  });
  const latest = exactRuns[0];
  if (latest.status !== "completed" || latest.conclusion !== "success") {
    throw new Error(
      `Latest hosted push CI for ${branch}@${head.slice(0, 12)} is ${latest.status}/${latest.conclusion || "pending"}.`,
    );
  }
  return latest;
}

function assertSuccessfulCiGateJob(jobs, workflowRunId, head) {
  const namedJobs = Array.isArray(jobs)
    ? jobs.filter((job) => job?.name === REQUIRED_CHECK)
    : [];
  const job = namedJobs[0];
  const checkRunId = String(job?.check_run_url || "").match(
    /\/check-runs\/([1-9]\d*)$/u,
  )?.[1];
  if (
    namedJobs.length !== 1 ||
    !Number.isSafeInteger(job?.id) ||
    job.id <= 0 ||
    job.run_id !== workflowRunId ||
    String(job.head_sha || "").toLowerCase() !== head.toLowerCase() ||
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    !Number.isSafeInteger(Number(checkRunId)) ||
    Number(checkRunId) <= 0
  ) {
    throw new Error(
      `Workflow run ${workflowRunId} has no unique successful ci-gate job bound to the exact run and HEAD.`,
    );
  }
  return { job, checkRunId: Number(checkRunId) };
}

function assertSuccessfulCiGateCheck(
  checkRuns,
  head,
  checkSuiteId,
  expectedCheckRunId,
) {
  const namedChecks = Array.isArray(checkRuns)
    ? checkRuns.filter(
        (check) =>
          check?.name === REQUIRED_CHECK &&
          check?.check_suite?.id === checkSuiteId,
      )
    : [];
  if (
    namedChecks.length !== 1 ||
    !Number.isSafeInteger(namedChecks[0]?.id) ||
    namedChecks[0].id <= 0 ||
    namedChecks[0].id !== expectedCheckRunId ||
    String(namedChecks[0].head_sha || "").toLowerCase() !==
      head.toLowerCase() ||
    namedChecks[0].app?.id !== REQUIRED_CHECK_APP_ID ||
    namedChecks[0].status !== "completed" ||
    namedChecks[0].conclusion !== "success"
  ) {
    throw new Error(
      "Latest hosted push CI has no unique successful GitHub Actions ci-gate for the exact workflow run and HEAD.",
    );
  }
  return namedChecks[0];
}

function assertSuccessfulHostedCiEvidence({
  branch,
  head,
  workflowRuns,
  ciGateJobs,
  ciGateChecks,
}) {
  const run = latestSuccessfulHostedCiRun(workflowRuns, branch, head);
  const { job, checkRunId } = assertSuccessfulCiGateJob(
    ciGateJobs,
    run.id,
    head,
  );
  const check = assertSuccessfulCiGateCheck(
    ciGateChecks,
    head,
    run.check_suite_id,
    checkRunId,
  );
  return { run, job, check };
}

function assertSuccessfulHostedCi(
  branch,
  head,
  { api = githubApi, env = process.env } = {},
) {
  const { owner, repo } = repositoryTarget(env);
  const prefix = `/repos/${owner}/${repo}`;
  const query = new URLSearchParams({
    branch,
    event: "push",
    head_sha: head,
    per_page: "100",
  });
  const runs = api(
    "GET",
    `${prefix}/actions/workflows/ci.yml/runs?${query}`,
  )?.workflow_runs;
  const latest = latestSuccessfulHostedCiRun(runs, branch, head);
  const jobs = api(
    "GET",
    `${prefix}/actions/runs/${latest.id}/jobs?filter=latest&per_page=100`,
  )?.jobs;
  const { checkRunId } = assertSuccessfulCiGateJob(jobs, latest.id, head);
  const checks = api(
    "GET",
    `${prefix}/check-suites/${latest.check_suite_id}/check-runs?check_name=${REQUIRED_CHECK}&filter=latest&per_page=100`,
  )?.check_runs;
  assertSuccessfulCiGateCheck(checks, head, latest.check_suite_id, checkRunId);
  return latest;
}

if (require.main === module) {
  try {
    if (!process.argv.includes("--apply")) {
      throw new Error(
        "Refusing to change GitHub settings without --apply. Use `npm run repo:protect-release-branches`.",
      );
    }
    assertGitHubCliAuthenticated();
    configureReleaseBranchProtection();
  } catch (error) {
    console.error(
      `release-branch-protection: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = {
  BETA_TAG_RULESET_INCLUDE,
  BETA_TAG_RULESET_NAME,
  DEFAULT_OWNER,
  DEFAULT_REPO,
  PROTECTED_RELEASE_BRANCHES,
  REQUIRED_CHECK,
  REQUIRED_CHECKS,
  REQUIRED_CHECK_APP_ID,
  REQUIRED_POLICY_CHECK,
  assertBetaTagProtection,
  assertBetaTagRulesetResponse,
  assertProtectionResponse,
  assertReleaseBranchProtection,
  assertSuccessfulHostedCi,
  assertSuccessfulHostedCiEvidence,
  assertSuccessfulCiGateJob,
  assertSuccessfulCiGateCheck,
  latestSuccessfulHostedCiRun,
  betaTagRulesetCollectionEndpoint,
  betaTagRulesetEndpoint,
  betaTagRulesetListBaseEndpoint,
  betaTagRulesetListEndpoint,
  betaTagRulesetMutationEndpoint,
  branchProtectionEndpoint,
  configureBetaTagProtection,
  configureReleaseBranchProtection,
  desiredBetaTagRuleset,
  desiredProtection,
  repositoryTarget,
  requiredStatusCheckNames,
};
