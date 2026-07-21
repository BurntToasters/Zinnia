#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const repoOwner = "BurntToasters";
const repoName = "Zinnia";

function expectedReleaseBranch(version) {
  return /-(?:alpha|beta|rc)(?:[.-]?\d+)?$/i.test(version) ? "beta" : "main";
}

function selectLatestCiRun(runs, { branch, sha }) {
  return runs
    .filter(
      (run) =>
        run?.name === "CI" &&
        run?.event === "push" &&
        run?.head_branch === branch &&
        run?.head_sha === sha &&
        run?.status === "completed",
    )
    .sort(
      (left, right) =>
        Date.parse(right.updated_at ?? right.created_at ?? 0) -
        Date.parse(left.updated_at ?? left.created_at ?? 0),
    )[0];
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function githubJson(apiPath) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Zinnia-Release-Preflight",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        hostname: "api.github.com",
        path: apiPath,
        headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `GitHub API returned ${response.statusCode}: ${body || "empty response"}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(
              new Error(
                `GitHub API returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        });
      },
    );
    request.setTimeout(30_000, () => {
      request.destroy(
        new Error("GitHub CI lookup timed out after 30 seconds."),
      );
    });
    request.on("error", reject);
  });
}

async function runPreflight() {
  const version = String(packageJson.version ?? "");
  const expectedBranch = expectedReleaseBranch(version);
  const branch = git(["branch", "--show-current"]);
  if (branch !== expectedBranch) {
    throw new Error(
      `${version} must be released from ${expectedBranch}, not ${branch || "detached HEAD"}.`,
    );
  }

  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty) {
    throw new Error(
      `Working tree is not clean. Commit and push the exact release source first:\n${dirty}`,
    );
  }

  git(["fetch", "--quiet", "origin"]);
  const upstream = git(["rev-parse", "--abbrev-ref", "@{upstream}"]);
  const expectedUpstream = `origin/${expectedBranch}`;
  if (upstream !== expectedUpstream) {
    throw new Error(
      `${expectedBranch} must track ${expectedUpstream}; current upstream is ${upstream}.`,
    );
  }

  const head = git(["rev-parse", "HEAD"]);
  const upstreamHead = git(["rev-parse", "@{upstream}"]);
  if (head !== upstreamHead) {
    throw new Error(
      `HEAD ${head.slice(0, 12)} does not match pushed ${expectedUpstream} ${upstreamHead.slice(0, 12)}.`,
    );
  }

  const query = new URLSearchParams({
    branch: expectedBranch,
    head_sha: head,
    status: "completed",
    per_page: "100",
  });
  const payload = await githubJson(
    `/repos/${repoOwner}/${repoName}/actions/runs?${query}`,
  );
  const latest = selectLatestCiRun(payload.workflow_runs ?? [], {
    branch: expectedBranch,
    sha: head,
  });
  if (!latest) {
    throw new Error(
      `No completed push CI run exists for ${expectedBranch}@${head}.`,
    );
  }
  if (latest.conclusion !== "success") {
    throw new Error(
      `Latest CI for ${expectedBranch}@${head.slice(0, 12)} is ${latest.conclusion}: ${latest.html_url}`,
    );
  }

  console.log(
    `release-preflight: ok (${version}, ${expectedBranch}@${head.slice(0, 12)}, ${latest.html_url})`,
  );
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  runPreflight().catch((error) => {
    console.error(
      `release-preflight: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

export { expectedReleaseBranch, selectLatestCiRun };
