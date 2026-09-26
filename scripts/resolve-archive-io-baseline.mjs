import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function resolveBetaBaseline(packageVersion, resolveTagCommit) {
  if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(packageVersion)) {
    throw new Error(
      `Candidate package version ${packageVersion} must be a beta version.`,
    );
  }
  const tag = `v${packageVersion}`;
  const sha = resolveTagCommit(tag);
  if (typeof sha !== "string" || !/^[0-9a-f]{40,64}$/i.test(sha)) {
    throw new Error(`The accepted beta tag ${tag} is unavailable.`);
  }
  return { tag, sha: sha.toLowerCase() };
}

function gitTagCommit(tag) {
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    },
  );
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

export function resolveCandidateBetaBaseline(packageJsonPath = "package.json") {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return resolveBetaBaseline(packageJson.version, gitTagCommit);
}

function main() {
  const { tag, sha } = resolveCandidateBetaBaseline();
  const outputs = `tag=${tag}\nsha=${sha}\n`;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, outputs);
  } else {
    process.stdout.write(outputs);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
