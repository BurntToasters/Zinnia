import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);

function expectedReleaseBranch(version) {
  return /-(?:alpha|beta|rc)(?:[.-]?\d+)?$/i.test(version) ? "beta" : "main";
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runPreflight() {
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

  console.log(
    `release-preflight: ok (${version}, ${expectedBranch}@${head.slice(0, 12)})`,
  );
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    runPreflight();
  } catch (error) {
    console.error(
      `release-preflight: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export { expectedReleaseBranch };
