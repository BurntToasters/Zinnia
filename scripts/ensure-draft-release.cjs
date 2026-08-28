// For some reason, I needed to make this script because GitHub started to split my releases into two drafts.
// make ONE machine the single creator (win), this script has two modes:
//   (default)  create-or-reuse the single draft. Run by the Windows machine only.
//   --wait     poll until that draft exists; NEVER create. Run by mac/linux so
//              they only ever reuse the draft Windows created (no duplicates).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

require("dotenv").config();
const {
  assertGitHubCliAuthenticated,
  githubApi,
} = require("./github-cli.cjs");
const { assertStableReleaseOverridesAllowed } = require("./release-policy.cjs");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const CHANGELOG_PATH = path.join(REPOSITORY_ROOT, "CHANGELOG.md");

const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
// Keep default casing aligned with scripts/gpg-sign.js and updater URLs.
const REPO_NAME = process.env.GH_REPO_NAME || "zinnia";
const GH_REQUEST_RETRIES = Number.parseInt(
  process.env.GH_REQUEST_RETRIES || "3",
  10,
);
const GH_REQUEST_RETRY_DELAY_MS = Number.parseInt(
  process.env.GH_REQUEST_RETRY_DELAY_MS || "1500",
  10,
);

// --wait mode: how long mac/linux will wait for the Windows machine to create
// the draft before giving up (defaults to 30 minutes, polling every 15s).
const WAIT_MODE = process.argv.slice(2).includes("--wait");
const WAIT_TIMEOUT_MS = Number.parseInt(
  process.env.RELEASE_DRAFT_WAIT_TIMEOUT_MS || "1800000",
  10,
);
const WAIT_POLL_INTERVAL_MS = Number.parseInt(
  process.env.RELEASE_DRAFT_WAIT_POLL_MS || "15000",
  10,
);

const packageJson = require("../package.json");
const VERSION = packageJson.version;
const TAG_NAME = "v" + VERSION;
// Keep this in sync with scripts/gpg-sign.js so every release path classifies
// release versions consistently and rejects unsupported channels.
const NUMERIC_VERSION = "(?:0|[1-9]\\d*)";
const BETA_VERSION = new RegExp(
  `^${NUMERIC_VERSION}\\.${NUMERIC_VERSION}\\.${NUMERIC_VERSION}-beta\\.${NUMERIC_VERSION}$`,
);
const STABLE_VERSION = new RegExp(
  `^${NUMERIC_VERSION}\\.${NUMERIC_VERSION}\\.${NUMERIC_VERSION}$`,
);
if (!BETA_VERSION.test(VERSION) && !STABLE_VERSION.test(VERSION)) {
  throw new Error(
    `Unsupported release version '${VERSION}'; Zinnia releases use beta or stable only.`,
  );
}
const IS_PRERELEASE = BETA_VERSION.test(VERSION);

function currentReleaseCommit() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("Could not resolve an exact release commit from git HEAD.");
  }
  return commit;
}

function readChangelogReleaseBody(changelogPath = CHANGELOG_PATH) {
  let body;
  try {
    body = fs.readFileSync(changelogPath, "utf8");
  } catch (error) {
    throw new Error(
      "CHANGELOG.md is required for GitHub release notes: " +
        (error && error.message ? error.message : String(error)),
      { cause: error },
    );
  }
  if (!body.trim()) {
    throw new Error(
      "CHANGELOG.md is empty; refusing to set blank release notes.",
    );
  }
  return body;
}

async function syncReleaseNotesBody(release, body) {
  if (!release || typeof release.id !== "number") {
    throw new Error("Cannot sync release notes without a GitHub release id.");
  }
  const updated = await githubRequestWithRetry(
    "PATCH",
    "/repos/" + REPO_OWNER + "/" + REPO_NAME + "/releases/" + release.id,
    { name: VERSION, body },
  );
  console.log(
    "   Synced CHANGELOG.md into release notes (" +
      body.length +
      " chars) for " +
      (release.name || TAG_NAME) +
      ".",
  );
  return updated;
}

function verifyReleaseSession(run = execFileSync) {
  const root = path.resolve(__dirname, "..");
  try {
    run(process.execPath, [path.join(__dirname, "release-session.js")], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || "")
      .trim()
      .replace(/^release-session: FAILED:\s*/m, "");
    throw new Error(
      "Release session verification failed. Run npm run release:prepare first." +
        (detail ? " " + detail : ""),
    );
  }
}

function isExplicitTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function assertReleaseTargetsCommit(
  release,
  commit,
  env = process.env,
  log = console,
) {
  if (release?.target_commitish === commit) return release;
  if (isExplicitTruthy(env.FORCE_UPLOAD)) {
    log.warn(
      "WARNING: Draft release " +
        TAG_NAME +
        " targets " +
        (release?.target_commitish || "an unknown commit") +
        ", not checked-out commit " +
        commit +
        ". FORCE_UPLOAD=1 bypassing commit check.",
    );
    return release;
  }
  throw new Error(
    "Draft release " +
      TAG_NAME +
      " targets " +
      (release?.target_commitish || "an unknown commit") +
      ", not checked-out commit " +
      commit +
      ". Delete or retarget stale draft before uploading assets. Or set FORCE_UPLOAD=1 to bypass.",
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGithubError(error) {
  if (!error) return false;

  const retryableStatusCodes = new Set([
    408, 409, 425, 429, 500, 502, 503, 504,
  ]);
  const retryableCodes = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "EPIPE",
  ]);

  if (
    typeof error.statusCode === "number" &&
    retryableStatusCodes.has(error.statusCode)
  ) {
    return true;
  }
  if (typeof error.code === "string" && retryableCodes.has(error.code)) {
    return true;
  }

  const msg = String(error.message || "").toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("socket hang up") ||
    msg.includes("aborted")
  );
}

function githubRequest(method, endpoint, body) {
  return Promise.resolve(githubApi(method, endpoint, body));
}

async function githubRequestWithRetry(method, endpoint, body) {
  const attempts = Math.max(1, GH_REQUEST_RETRIES);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await githubRequest(method, endpoint, body);
    } catch (error) {
      const canRetry = attempt < attempts && isRetryableGithubError(error);
      if (!canRetry) {
        throw error;
      }

      const backoffMs = GH_REQUEST_RETRY_DELAY_MS * attempt;
      console.log(
        "   Retry " +
          attempt +
          "/" +
          (attempts - 1) +
          " in " +
          backoffMs +
          "ms (" +
          error.message +
          ")",
      );
      await sleep(backoffMs);
    }
  }
}

/**
 * Walk GitHub list endpoints page-by-page until an empty page or a short page.
 * Kept in sync with scripts/gpg-sign.js `listAllGithubPages`.
 */
async function listAllGithubPages(fetchPage, { perPage = 100 } = {}) {
  const pageSize = Math.max(1, Number(perPage) || 100);
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchPage(page, pageSize);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < pageSize) break;
  }
  return items;
}

async function findMatchingReleases() {
  // Draft releases are not returned by the "get release by tag" endpoint
  // (no git tag exists yet), so we list and match on tag_name.
  const releases = await listAllGithubPages((page, perPage) =>
    githubRequestWithRetry(
      "GET",
      "/repos/" +
        REPO_OWNER +
        "/" +
        REPO_NAME +
        "/releases?per_page=" +
        perPage +
        "&page=" +
        page,
    ),
  );
  return releases.filter((r) => r.tag_name === TAG_NAME);
}

async function findExistingRelease() {
  const matching = await findMatchingReleases();
  // Never treat a published release as a draft handoff target.
  return matching.find((r) => r.draft) || null;
}

async function ensureDraftRelease() {
  console.log("Ensuring draft release exists for " + TAG_NAME + "...");
  const commit = currentReleaseCommit();
  const body = readChangelogReleaseBody();

  const matching = await findMatchingReleases();
  const existing = matching.find((r) => r.draft) || null;
  if (existing) {
    assertReleaseTargetsCommit(existing, commit);
    console.log(
      "   Draft already exists: " +
        (existing.name || TAG_NAME) +
        " (id " +
        existing.id +
        ", " +
        (existing.assets ? existing.assets.length : 0) +
        " assets) - refreshing release notes.",
    );
    return assertReleaseTargetsCommit(
      await syncReleaseNotesBody(existing, body),
      commit,
    );
  }
  if (matching.some((r) => !r.draft)) {
    throw new Error(
      "Release " +
        TAG_NAME +
        " already exists as published. Refusing to create another draft for the same tag.",
    );
  }

  console.log("   No release found. Creating draft...");
  try {
    const release = await githubRequestWithRetry(
      "POST",
      "/repos/" + REPO_OWNER + "/" + REPO_NAME + "/releases",
      {
        // Match electron-builder's createRelease() so it reuses this draft:
        // tag = "v" + version, name defaults to the version, draft:true.
        tag_name: TAG_NAME,
        target_commitish: commit,
        name: VERSION,
        body,
        draft: true,
        prerelease: IS_PRERELEASE,
      },
    );
    console.log(
      "   Created draft release: " +
        (release.name || TAG_NAME) +
        " (id " +
        release.id +
        ") with CHANGELOG.md release notes.",
    );
    return assertReleaseTargetsCommit(release, commit);
  } catch (error) {
    // Another concurrent run may have created it (422 already_exists) - re-fetch.
    if (error.statusCode === 422) {
      console.log("   Create returned 422; re-checking for existing draft...");
      await sleep(2000);
      const afterRetry = await findExistingRelease();
      if (afterRetry) {
        assertReleaseTargetsCommit(afterRetry, commit);
        console.log("   Found existing draft after retry: id " + afterRetry.id);
        return assertReleaseTargetsCommit(
          await syncReleaseNotesBody(afterRetry, body),
          commit,
        );
      }
    }
    throw error;
  }
}

async function waitForDraftRelease() {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  console.log(
    "Waiting for draft release " +
      TAG_NAME +
      " (created by the Windows machine); will NOT create it here...",
  );

  let attempt = 0;
  const commit = currentReleaseCommit();
  for (;;) {
    attempt += 1;
    const matching = await findMatchingReleases();
    const existing = matching.find((r) => r.draft) || null;
    if (existing) {
      assertReleaseTargetsCommit(existing, commit);
      console.log(
        "   Found draft: " +
          (existing.name || TAG_NAME) +
          " (id " +
          existing.id +
          ", " +
          (existing.assets ? existing.assets.length : 0) +
          " assets). Proceeding.",
      );
      return existing;
    }
    if (matching.some((r) => !r.draft)) {
      throw new Error(
        "Release " +
          TAG_NAME +
          " already exists as published. Refusing to wait for a draft for the same tag.",
      );
    }

    if (Date.now() >= deadline) {
      throw new Error(
        "Timed out after " +
          Math.round(WAIT_TIMEOUT_MS / 1000) +
          "s waiting for draft " +
          TAG_NAME +
          '. Run "npm run release:draft" on the Windows machine first (or run it here once), then retry.',
      );
    }

    console.log(
      "   Draft not found yet (attempt " +
        attempt +
        "); re-checking in " +
        Math.round(WAIT_POLL_INTERVAL_MS / 1000) +
        "s...",
    );
    await sleep(WAIT_POLL_INTERVAL_MS);
  }
}

async function main() {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  assertGitHubCliAuthenticated();

  verifyReleaseSession();

  if (WAIT_MODE) {
    await waitForDraftRelease();
  } else {
    await ensureDraftRelease();
  }
}

module.exports = {
  assertReleaseTargetsCommit,
  currentReleaseCommit,
  listAllGithubPages,
  readChangelogReleaseBody,
  syncReleaseNotesBody,
  verifyReleaseSession,
};

if (require.main === module) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error("✗ ERROR: Failed to ensure draft release: " + message);
    process.exit(1);
  });
}
