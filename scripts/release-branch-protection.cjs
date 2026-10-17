#!/usr/bin/env node
"use strict";

const { githubApi, assertGitHubCliAuthenticated } = require("./github-cli.cjs");

const DEFAULT_OWNER = "BurntToasters";
const DEFAULT_REPO = "zinnia";
const REQUIRED_CHECK = "ci-gate";
const REQUIRED_CHECK_APP_ID = 15368;
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
      `Repository beta tag ruleset is missing. Run node scripts/release-branch-protection.cjs --apply with repository admin access before accepting beta tags.`,
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
    `beta-tag-protection: enforced ${BETA_TAG_RULESET_INCLUDE} immutability with no bypass actors`,
  );
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
        "Refusing to change GitHub settings without --apply. Add --apply to enforce the immutable beta tag ruleset.",
      );
    }
    assertGitHubCliAuthenticated();
    configureBetaTagProtection();
  } catch (error) {
    console.error(
      `beta-tag-protection: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = {
  BETA_TAG_RULESET_INCLUDE,
  BETA_TAG_RULESET_NAME,
  DEFAULT_OWNER,
  DEFAULT_REPO,
  REQUIRED_CHECK,
  REQUIRED_CHECK_APP_ID,
  assertBetaTagProtection,
  assertBetaTagRulesetResponse,
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
  configureBetaTagProtection,
  desiredBetaTagRuleset,
  repositoryTarget,
};
