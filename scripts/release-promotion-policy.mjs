#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const BETA_VERSION_PATTERN =
  /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-beta\.(?:0|[1-9]\d*)$/;
const STABLE_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const require = createRequire(import.meta.url);
const {
  BETA_TAG_RULESET_NAME,
  assertBetaTagRulesetResponse,
  assertSuccessfulCiGateJob,
  assertSuccessfulCiGateCheck,
  betaTagRulesetEndpoint,
  betaTagRulesetListBaseEndpoint,
  latestSuccessfulHostedCiRun,
} = require("./release-branch-protection.cjs");

function isNonshippingPath(path) {
  if (
    /^(?:CHANGELOG|README|ARCHITECTURE|SECURITY|build-setup)\.md$/u.test(path)
  ) {
    return true;
  }
  if (/^docs\/(?:[^/]+\/)*[^/]+\.md$/u.test(path)) return true;
  if (
    /^src\/tests\/(?:[^/]+\/)*[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)
  ) {
    return true;
  }
  if (/^scripts\/(?:[^/]+\/)*[^/]+\.test\.[cm]?[jt]s$/u.test(path)) {
    return true;
  }
  if (/^e2e\/specs\/(?:[^/]+\/)*[^/]+\.spec\.[cm]?[jt]s$/u.test(path)) {
    return true;
  }
  return /^src-tauri\/tests\/(?:[^/]+\/)*[^/]+\.rs$/u.test(path);
}

export function validatePromotionCandidate({
  headRef,
  headVersion,
  headRepository,
  baseRepository,
  labels,
  betaSha,
  taggedVersion,
  changedEntries,
}) {
  const match = String(headVersion).match(BETA_VERSION_PATTERN);
  if (!match) {
    throw new Error(
      "Promotion candidate package version must be an exact beta version.",
    );
  }
  if (headRef !== `next-${match[1]}`) {
    throw new Error(
      `Promotion branch must be next-${match[1]}; found ${headRef}.`,
    );
  }
  if (
    typeof headRepository !== "string" ||
    typeof baseRepository !== "string" ||
    headRepository.toLowerCase() !== baseRepository.toLowerCase()
  ) {
    throw new Error(
      "Promotion candidate must come from the canonical repository.",
    );
  }
  if (!SHA_PATTERN.test(String(betaSha))) {
    throw new Error("Accepted beta tag must resolve to a commit SHA.");
  }
  if (taggedVersion !== headVersion) {
    throw new Error(
      "Accepted beta tag package version differs from the candidate.",
    );
  }
  // The beta tag ruleset requirement is intentionally disabled for now;
  // releases are cut from maintainer-controlled release VMs.
  const tag = `v${headVersion}`;
  const acceptanceLabels = Array.isArray(labels)
    ? labels.filter((label) =>
        String(label?.name || "").startsWith("accepted-beta:"),
      )
    : [];
  if (
    acceptanceLabels.length !== 1 ||
    acceptanceLabels[0].name !== `accepted-beta:${tag}` ||
    String(acceptanceLabels[0].description || "").trim() !==
      `sha=${betaSha.toLowerCase()}`
  ) {
    throw new Error(
      `Promotion requires one maintainer-applied accepted-beta:${tag} label with description sha=${betaSha.toLowerCase()}.`,
    );
  }
  if (!Array.isArray(changedEntries)) {
    throw new Error("Accepted beta tree comparison is unavailable.");
  }
  const unexpected = changedEntries.filter(
    ({ status, path }) =>
      (status !== "A" && status !== "M") ||
      typeof path !== "string" ||
      !isNonshippingPath(path),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Production or release tooling differs from the accepted beta tag:\n${unexpected.map(({ status, path }) => `${status}\t${path}`).join("\n")}. Publish and accept a fresh beta first.`,
    );
  }
  return { tag, sha: betaSha.toLowerCase() };
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trimEnd();
}

function versionAt(ref) {
  return JSON.parse(git(["show", `${ref}:package.json`])).version;
}

function changedEntriesBetween(betaSha, headSha) {
  const output = git([
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    betaSha,
    headSha,
  ]);
  if (!output) return [];
  const fields = output.split("\0").filter(Boolean);
  if (fields.length % 2 !== 0) {
    throw new Error("Accepted beta tree comparison returned malformed paths.");
  }
  const entries = [];
  for (let index = 0; index < fields.length; index += 2) {
    entries.push({ status: fields[index], path: fields[index + 1] });
  }
  return entries;
}

function checkStableMetadata(baseSha, headSha) {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-stable-metadata-pr.mjs", baseSha, headSha],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Trusted stable metadata check failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

function readPullRequestEvent() {
  if (!process.env.GITHUB_EVENT_PATH) {
    throw new Error(
      "GITHUB_EVENT_PATH is required for the trusted release policy.",
    );
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pullRequest = event.pull_request;
  if (!pullRequest || pullRequest.base?.ref !== "main") {
    throw new Error(
      "Trusted release policy requires a pull request targeting main.",
    );
  }
  return pullRequest;
}

function githubRepositoryEnvironment(env = process.env) {
  const [owner, repo, extra] = String(env.GITHUB_REPOSITORY || "").split("/");
  if (!owner || !repo || extra) {
    throw new Error(
      "GITHUB_REPOSITORY must identify one owner and repository.",
    );
  }
  return { GH_REPO_OWNER: owner, GH_REPO_NAME: repo };
}

async function githubApiGet(endpoint) {
  const token = String(process.env.GITHUB_TOKEN || "");
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is required for trusted GitHub policy API requests.",
    );
  }
  const apiUrl = String(
    process.env.GITHUB_API_URL || "https://api.github.com",
  ).replace(/\/+$/u, "");
  const response = await fetch(`${apiUrl}${endpoint}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub release policy API request failed with HTTP ${response.status}.`,
    );
  }
  return response.json();
}

async function fetchCurrentPullRequest(prNumber) {
  const { GH_REPO_OWNER, GH_REPO_NAME } = githubRepositoryEnvironment();
  const endpoint = `/repos/${encodeURIComponent(GH_REPO_OWNER)}/${encodeURIComponent(GH_REPO_NAME)}/pulls/${prNumber}`;
  return githubApiGet(endpoint);
}

function apiRepositoryPrefix(owner, repo) {
  if (
    typeof owner !== "string" ||
    !owner ||
    typeof repo !== "string" ||
    !repo ||
    owner.includes("/") ||
    repo.includes("/")
  ) {
    throw new Error("Accepted beta verification requires a valid repository.");
  }
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function fetchAllApiPages({
  apiGet,
  endpoint,
  selectArray,
  description,
}) {
  const values = [];
  const pageSize = 100;
  const maximumPages = 1000;
  for (let page = 1; page <= maximumPages; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const response = await apiGet(
      `${endpoint}${separator}per_page=${pageSize}&page=${page}`,
    );
    const entries = selectArray(response);
    if (!Array.isArray(entries)) {
      throw new Error(`GitHub returned malformed ${description} evidence.`);
    }
    values.push(...entries);
    if (entries.length < pageSize) {
      if (
        Number.isSafeInteger(response?.total_count) &&
        response.total_count !== values.length
      ) {
        throw new Error(`GitHub returned incomplete ${description} evidence.`);
      }
      return values;
    }
  }
  throw new Error(
    `GitHub ${description} evidence exceeds the safe page limit.`,
  );
}

function latestLabelApplication(events, labelName) {
  if (!Array.isArray(events)) {
    throw new Error("GitHub label application event history is unavailable.");
  }
  const matching = events.filter((entry) => entry?.label?.name === labelName);
  matching.sort((left, right) => {
    const dateOrder =
      Date.parse(left?.created_at || "") - Date.parse(right?.created_at || "");
    if (Number.isFinite(dateOrder) && dateOrder !== 0) return dateOrder;
    return Number(left?.id || 0) - Number(right?.id || 0);
  });
  const latest = matching.at(-1);
  if (
    latest?.event !== "labeled" ||
    !Number.isSafeInteger(latest.id) ||
    latest.id <= 0 ||
    !Number.isFinite(Date.parse(latest.created_at || "")) ||
    typeof latest.actor?.login !== "string" ||
    !latest.actor.login.trim()
  ) {
    throw new Error(
      `The current ${labelName} label has no trusted label application event.`,
    );
  }
  return latest;
}

function assertMaintainerOrAdminPermission(permission, actorLogin) {
  const returnedLogin = String(permission?.user?.login || "");
  const roleName = String(permission?.role_name || "").toLowerCase();
  const basePermission = String(permission?.permission || "").toLowerCase();
  if (
    !returnedLogin ||
    returnedLogin.toLowerCase() !== actorLogin.toLowerCase() ||
    !(
      roleName === "admin" ||
      roleName === "maintain" ||
      basePermission === "admin" ||
      basePermission === "maintain"
    )
  ) {
    throw new Error(
      `Accepted beta label must be applied by a repository maintainer or admin; ${actorLogin} is not currently verified as one.`,
    );
  }
  return roleName || basePermission;
}

async function loadLatestTrustedBetaCiGate({
  apiGet,
  repositoryPrefix,
  betaSha,
}) {
  const workflowRuns = await fetchAllApiPages({
    apiGet,
    endpoint: `${repositoryPrefix}/actions/workflows/ci.yml/runs?branch=beta&event=push&head_sha=${encodeURIComponent(betaSha)}`,
    selectArray: (response) =>
      Array.isArray(response?.workflow_runs) ? response.workflow_runs : [],
    description: "accepted beta push CI run",
  });
  let latestRun;
  try {
    latestRun = latestSuccessfulHostedCiRun(workflowRuns, "beta", betaSha);
  } catch {
    throw new Error(
      `Accepted beta ${betaSha} requires a successful push CI run from .github/workflows/ci.yml on refs/heads/beta.`,
    );
  }
  const jobs = await fetchAllApiPages({
    apiGet,
    endpoint: `${repositoryPrefix}/actions/runs/${latestRun.id}/jobs?filter=latest`,
    selectArray: (response) =>
      Array.isArray(response?.jobs) ? response.jobs : [],
    description: "accepted beta ci-gate job",
  });
  let gateJob;
  try {
    gateJob = assertSuccessfulCiGateJob(jobs, latestRun.id, betaSha);
  } catch {
    throw new Error(
      `Accepted beta ${betaSha} requires one successful ci-gate job bound to workflow run ${latestRun.id}.`,
    );
  }
  const checks = await fetchAllApiPages({
    apiGet,
    endpoint: `${repositoryPrefix}/check-suites/${latestRun.check_suite_id}/check-runs?check_name=ci-gate&filter=latest`,
    selectArray: (response) =>
      Array.isArray(response?.check_runs) ? response.check_runs : [],
    description: "accepted beta ci-gate",
  });
  let check;
  try {
    check = assertSuccessfulCiGateCheck(
      checks,
      betaSha,
      latestRun.check_suite_id,
      gateJob.checkRunId,
    );
  } catch {
    throw new Error(
      `Accepted beta ${betaSha} requires a successful trusted hosted ci-gate from GitHub Actions bound to workflow run ${latestRun.id}.`,
    );
  }
  return { run: latestRun, job: gateJob.job, check };
}

async function loadAcceptedBetaAttestationSnapshot({
  apiGet,
  eventPr,
  owner,
  repo,
  tag,
  betaSha,
}) {
  const repositoryPrefix = apiRepositoryPrefix(owner, repo);
  const repositoryFullName = `${owner}/${repo}`;
  if (
    eventPr?.base?.repo?.full_name?.toLowerCase() !==
      repositoryFullName.toLowerCase() ||
    eventPr?.head?.repo?.full_name?.toLowerCase() !==
      repositoryFullName.toLowerCase()
  ) {
    throw new Error("Accepted beta policy requires a canonical repository PR.");
  }
  const prNumber = Number(eventPr.number);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(
      "Accepted beta policy requires a valid pull request number.",
    );
  }
  const currentPr = await apiGet(`${repositoryPrefix}/pulls/${prNumber}`);
  assertCurrentPromotionPullRequest(eventPr, currentPr, { tag, betaSha });

  const labelName = `accepted-beta:${tag}`;
  const events = await fetchAllApiPages({
    apiGet,
    endpoint: `${repositoryPrefix}/issues/${prNumber}/events`,
    selectArray: (response) => response,
    description: "label application event",
  });
  const application = latestLabelApplication(events, labelName);
  const appliedBy = application.actor.login.trim();
  const permission = await apiGet(
    `${repositoryPrefix}/collaborators/${encodeURIComponent(appliedBy)}/permission`,
  );
  const role = assertMaintainerOrAdminPermission(permission, appliedBy);

  const release = await apiGet(
    `${repositoryPrefix}/releases/tags/${encodeURIComponent(tag)}`,
  );
  if (
    !Number.isSafeInteger(release?.id) ||
    release.id <= 0 ||
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== true ||
    !Number.isFinite(Date.parse(release.published_at || ""))
  ) {
    throw new Error(
      `Accepted beta tag ${tag} must have a published beta prerelease.`,
    );
  }

  const {
    run: ciWorkflowRun,
    job: ciGateJob,
    check: ciGate,
  } = await loadLatestTrustedBetaCiGate({
    apiGet,
    repositoryPrefix,
    betaSha,
  });
  return {
    tag,
    sha: betaSha.toLowerCase(),
    headSha: String(currentPr.head.sha).toLowerCase(),
    labelEventId: application.id,
    labelEventAction: application.event,
    appliedBy,
    appliedRole: role,
    releaseId: release.id,
    releasePublishedAt: release.published_at,
    ciGateId: ciGate.id,
    ciGateJobId: ciGateJob.id,
    ciGateSuiteId: ciGate.check_suite.id,
    ciWorkflowRunId: ciWorkflowRun.id,
  };
}

export async function verifyAcceptedBetaAttestation({
  apiGet = githubApiGet,
  eventPr,
  owner,
  repo,
  tag,
  betaSha,
}) {
  if (!SHA_PATTERN.test(String(betaSha || ""))) {
    throw new Error("Accepted beta attestation requires a commit SHA.");
  }
  const input = { apiGet, eventPr, owner, repo, tag, betaSha };
  const first = await loadAcceptedBetaAttestationSnapshot(input);
  const final = await loadAcceptedBetaAttestationSnapshot(input);
  if (JSON.stringify(first) !== JSON.stringify(final)) {
    throw new Error(
      "Accepted beta attestation changed during final revalidation; rerun the policy.",
    );
  }
  return final;
}

export async function loadBetaTagRuleset(
  apiGet = githubApiGet,
  env = process.env,
) {
  const { GH_REPO_OWNER, GH_REPO_NAME } = githubRepositoryEnvironment(env);
  const repositoryEnv = { GH_REPO_OWNER, GH_REPO_NAME };
  const list = await fetchAllApiPages({
    apiGet,
    endpoint: betaTagRulesetListBaseEndpoint(repositoryEnv),
    selectArray: (response) => response,
    description: "repository beta tag ruleset",
  });
  const matching = list.filter(
    (ruleset) => ruleset?.name === BETA_TAG_RULESET_NAME,
  );
  if (matching.length !== 1 || !Number.isSafeInteger(matching[0]?.id)) {
    throw new Error(
      "Repository beta tag ruleset is missing or ambiguous; stable promotion is blocked.",
    );
  }
  const ruleset = await apiGet(
    betaTagRulesetEndpoint(matching[0].id, repositoryEnv),
  );
  return assertBetaTagRulesetResponse(ruleset, {
    // GitHub hides bypass_actors from read-only callers. release:preflight
    // verifies the empty bypass list with repository administration access.
    requireNoBypassActors: false,
  });
}

async function verifyRemoteAcceptedBetaTag(tag, expectedSha, expectedVersion) {
  git(["fetch", "--no-tags", "origin", `refs/tags/${tag}`]);
  const liveSha = git(["rev-parse", "FETCH_HEAD^{commit}"]).toLowerCase();
  if (liveSha !== String(expectedSha).toLowerCase()) {
    throw new Error(
      `Accepted beta tag ${tag} moved from ${expectedSha} to ${liveSha}.`,
    );
  }
  if (versionAt(liveSha) !== expectedVersion) {
    throw new Error(
      `Accepted beta tag ${tag} no longer has version ${expectedVersion}.`,
    );
  }
  return liveSha;
}

export async function revalidateAcceptedBetaTagAfterAttestation({
  tag,
  betaSha,
  version,
  attest,
  resolveTag = verifyRemoteAcceptedBetaTag,
}) {
  if (!SHA_PATTERN.test(String(betaSha || ""))) {
    throw new Error("Final beta tag verification requires a commit SHA.");
  }
  if (typeof attest !== "function") {
    throw new Error(
      "Final beta tag verification requires the final attestation reads.",
    );
  }
  await attest();
  const resolvedSha = String(
    (await resolveTag(tag, betaSha, version)) || "",
  ).toLowerCase();
  if (resolvedSha !== betaSha.toLowerCase()) {
    throw new Error(
      `Accepted beta tag ${tag} moved from ${betaSha} to ${resolvedSha || "an unresolved target"}.`,
    );
  }
  return resolvedSha;
}

function acceptedBetaLabel(pr, tag) {
  const acceptanceLabels = Array.isArray(pr.labels)
    ? pr.labels.filter((label) =>
        String(label?.name || "").startsWith("accepted-beta:"),
      )
    : [];
  if (
    acceptanceLabels.length !== 1 ||
    acceptanceLabels[0].name !== `accepted-beta:${tag}`
  ) {
    throw new Error(`Promotion requires one accepted-beta:${tag} label.`);
  }
  const sha = String(acceptanceLabels[0].description || "")
    .trim()
    .match(/^sha=((?:[0-9a-f]{40}|[0-9a-f]{64}))$/iu)?.[1];
  if (!sha) {
    throw new Error(`Accepted beta label for ${tag} must record a commit SHA.`);
  }
  return sha.toLowerCase();
}

export function assertCurrentPromotionPullRequest(
  eventPr,
  currentPr,
  { tag, betaSha } = {},
) {
  const eventNumber = Number(eventPr?.number);
  const currentNumber = Number(currentPr?.number);
  const eventHeadSha = String(eventPr?.head?.sha || "");
  const currentHeadSha = String(currentPr?.head?.sha || "");
  const eventBaseRepository = eventPr?.base?.repo?.full_name;
  const currentBaseRepository = currentPr?.base?.repo?.full_name;
  const eventHeadRepository = eventPr?.head?.repo?.full_name;
  const currentHeadRepository = currentPr?.head?.repo?.full_name;
  if (
    !Number.isSafeInteger(eventNumber) ||
    eventNumber <= 0 ||
    currentNumber !== eventNumber ||
    currentPr?.state !== "open" ||
    eventPr?.base?.ref !== "main" ||
    currentPr?.base?.ref !== eventPr.base.ref ||
    currentPr?.head?.ref !== eventPr?.head?.ref ||
    !SHA_PATTERN.test(eventHeadSha) ||
    !SHA_PATTERN.test(currentHeadSha) ||
    currentHeadSha.toLowerCase() !== eventHeadSha.toLowerCase() ||
    typeof eventBaseRepository !== "string" ||
    typeof currentBaseRepository !== "string" ||
    currentBaseRepository.toLowerCase() !== eventBaseRepository.toLowerCase() ||
    typeof eventHeadRepository !== "string" ||
    typeof currentHeadRepository !== "string" ||
    currentHeadRepository.toLowerCase() !== eventHeadRepository.toLowerCase()
  ) {
    throw new Error(
      "Pull request head changed during policy evaluation, or its identity changed; rerun the policy on the current head.",
    );
  }

  if (tag) {
    const currentBetaSha = acceptedBetaLabel(currentPr, tag);
    if (
      !SHA_PATTERN.test(String(betaSha || "")) ||
      currentBetaSha !== String(betaSha).toLowerCase()
    ) {
      throw new Error(
        `Current pull request accepted-beta:${tag} label no longer pins the verified beta commit.`,
      );
    }
  }
  return currentPr;
}

async function revalidateAcceptedBetaTag(pr) {
  const baseRepository = pr.base.repo?.full_name;
  const headRepository = pr.head.repo?.full_name;
  if (
    !baseRepository ||
    !headRepository ||
    baseRepository.toLowerCase() !== headRepository.toLowerCase()
  ) {
    throw new Error(
      "Release pull request must come from the canonical repository.",
    );
  }
  const headRef = String(pr.head.ref || "");
  const prNumber = Number(pr.number);
  const expectedHeadSha = String(pr.head.sha || "");
  if (
    !Number.isSafeInteger(prNumber) ||
    prNumber <= 0 ||
    !SHA_PATTERN.test(expectedHeadSha)
  ) {
    throw new Error("Pull request event has invalid commit SHA or number.");
  }
  git(["fetch", "--no-tags", "origin", `refs/pull/${prNumber}/head`]);
  const fetchedHeadSha = git(["rev-parse", "FETCH_HEAD^{commit}"]);
  if (fetchedHeadSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
    throw new Error(
      "Fetched pull request head changed before policy completion.",
    );
  }

  let tag;
  let liveSha;
  if (headRef.startsWith("next-")) {
    const version = versionAt(expectedHeadSha);
    const match = version.match(BETA_VERSION_PATTERN);
    if (!match || headRef !== `next-${match[1]}`) {
      throw new Error("Promotion branch name and beta package version differ.");
    }
    tag = `v${version}`;
    const expectedBetaSha = acceptedBetaLabel(pr, tag);
    liveSha = await verifyRemoteAcceptedBetaTag(tag, expectedBetaSha, version);
  } else if (!headRef.startsWith("release/")) {
    throw new Error(
      "Final release-policy revalidation received an unsupported branch.",
    );
  }

  // Do this last: the labels or head can change after the earlier source and
  // tag checks, including while those checks are running.
  const currentPr = await fetchCurrentPullRequest(prNumber);
  assertCurrentPromotionPullRequest(pr, currentPr, {
    tag,
    betaSha: liveSha,
  });
  if (tag) {
    const { GH_REPO_OWNER, GH_REPO_NAME } = githubRepositoryEnvironment();
    await revalidateAcceptedBetaTagAfterAttestation({
      tag,
      betaSha: liveSha,
      version: versionAt(liveSha),
      attest: () =>
        verifyAcceptedBetaAttestation({
          apiGet: githubApiGet,
          eventPr: pr,
          owner: GH_REPO_OWNER,
          repo: GH_REPO_NAME,
          tag,
          betaSha: liveSha,
        }),
    });
  }
  console.log(
    tag
      ? `release-policy: revalidated ${tag}@${liveSha} and current PR before success`
      : "release-policy: revalidated current stable metadata PR before success",
  );
}

async function main() {
  const pr = readPullRequestEvent();
  const baseSha = String(pr.base.sha || "");
  const expectedHeadSha = String(pr.head.sha || "");
  const prNumber = Number(pr.number);
  if (
    !SHA_PATTERN.test(baseSha) ||
    !SHA_PATTERN.test(expectedHeadSha) ||
    !Number.isSafeInteger(prNumber) ||
    prNumber <= 0
  ) {
    throw new Error("Pull request event has invalid commit SHA or number.");
  }
  if (git(["rev-parse", "HEAD"]) !== baseSha) {
    throw new Error(
      "Trusted policy checkout does not match pull request base SHA.",
    );
  }
  const headRef = String(pr.head.ref || "");
  const headRepository = pr.head.repo?.full_name;
  const baseRepository = pr.base.repo?.full_name;
  if (
    !headRepository ||
    !baseRepository ||
    headRepository.toLowerCase() !== baseRepository.toLowerCase()
  ) {
    throw new Error(
      "Release pull request must come from the canonical repository.",
    );
  }

  // Fetch PR objects as inert data. HEAD stays on the trusted base commit;
  // no package install, script, or workflow from the PR is ever executed here.
  git(["fetch", "--no-tags", "origin", `refs/pull/${prNumber}/head`]);
  const headSha = git(["rev-parse", "FETCH_HEAD^{commit}"]);
  if (headSha !== expectedHeadSha) {
    throw new Error(
      "Fetched pull request head changed after the event; rerun on the new head.",
    );
  }
  const headVersion = versionAt(headSha);

  if (headRef.startsWith("next-")) {
    const match = String(headVersion).match(BETA_VERSION_PATTERN);
    if (!match || headRef !== `next-${match[1]}`) {
      throw new Error("Promotion branch name and beta package version differ.");
    }
    const tag = `v${headVersion}`;
    git(["fetch", "--no-tags", "origin", `refs/tags/${tag}`]);
    const betaSha = git(["rev-parse", "FETCH_HEAD^{commit}"]);
    validatePromotionCandidate({
      headRef,
      headVersion,
      headRepository,
      baseRepository,
      labels: pr.labels,
      betaSha,
      taggedVersion: versionAt(betaSha),
      changedEntries: changedEntriesBetween(betaSha, headSha),
    });
    await verifyRemoteAcceptedBetaTag(tag, betaSha, headVersion);
    console.log(
      `release-policy: accepted ${headRef}@${headSha} against ${tag}@${betaSha}`,
    );
    return;
  }
  if (headRef.startsWith("release/")) {
    if (
      !STABLE_VERSION_PATTERN.test(String(headVersion)) ||
      headRef !== `release/${headVersion}`
    ) {
      throw new Error(`Stable metadata branch must be release/${headVersion}.`);
    }
    checkStableMetadata(baseSha, headSha);
    console.log(
      `release-policy: accepted stable metadata ${headRef}@${headSha}`,
    );
    return;
  }
  throw new Error(
    "Main accepts only next-X.Y.Z promotion or release/X.Y.Z metadata pull requests.",
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  const execution = process.argv.includes("--revalidate-beta-tag")
    ? revalidateAcceptedBetaTag(readPullRequestEvent())
    : main();
  execution.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
