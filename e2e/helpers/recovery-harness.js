import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { requireHostSidecar, run7z } from "../../scripts/archive-fixtures.js";
import { APP_ID, REPO_ROOT, windowsProfilePaths } from "./profile.js";

export const RECOVERY_PLAN_PATH = path.join(
  REPO_ROOT,
  "e2e",
  "recovery-plan.json",
);
export const CRASH_SPEC = "./specs/crash-injection.spec.js";
export const RECOVERY_SPEC = "./specs/crash-recovery.spec.js";
export const JOURNAL_FILE_NAME = "active-transaction.json";

const LEFTOVER_NAME = /^\.zinnia-|\.move-plan\.json$|\.move-identities\.jsonl$/;

export function loadRecoveryPlan(planPath = RECOVERY_PLAN_PATH) {
  return JSON.parse(fs.readFileSync(planPath, "utf8"));
}

/** Expected wdio suite count: base suites, a crash/recovery pair per case, one per scenario spec. */
export function expectedRecoverySuiteCount(plan) {
  return 2 + plan.crashCases.length * 2 + plan.scenarioSpecs.length;
}

export function sha256File(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

/** Cache location of the active transaction journal for an E2E profile. */
export function journalPathForProfile(profileDir, platform = process.platform) {
  if (platform === "darwin") {
    return path.join(
      profileDir,
      "home",
      "Library",
      "Caches",
      APP_ID,
      JOURNAL_FILE_NAME,
    );
  }
  if (platform === "win32") {
    return path.join(
      windowsProfilePaths(path.join(profileDir, "home")).local,
      APP_ID,
      JOURNAL_FILE_NAME,
    );
  }
  return path.join(profileDir, "cache", APP_ID, JOURNAL_FILE_NAME);
}

/**
 * Stable, sorted description of a tree: every entry's kind plus its size and
 * SHA-256 (files) or link target (symlinks). Returns null when the root is
 * absent so "nothing created" is distinguishable from an empty directory.
 */
export function treeManifest(root) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const entries = [];
  const walk = (dir, relative) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        entries.push({
          path: rel,
          kind: "link",
          target: fs.readlinkSync(full),
        });
      } else if (stat.isDirectory()) {
        entries.push({ path: rel, kind: "dir" });
        walk(full, rel);
      } else if (stat.isFile()) {
        entries.push({
          path: rel,
          kind: "file",
          size: stat.size,
          sha256: sha256File(full),
        });
      } else {
        entries.push({ path: rel, kind: "other" });
      }
    }
  };
  if (rootStat.isDirectory()) {
    walk(root, "");
  } else {
    entries.push({
      path: ".",
      kind: "file",
      size: rootStat.size,
      sha256: sha256File(root),
    });
  }
  return entries;
}

/** Relative paths of recovery leftovers (stage dirs, sidecars) anywhere under root. */
export function findLeftovers(root) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  const walk = (dir, relative) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (LEFTOVER_NAME.test(entry.name)) found.push(rel);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(path.join(dir, entry.name), rel);
      }
    }
  };
  walk(root, "");
  return found.sort();
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Lay out one crash case under the profile work dir. Returns the caseInfo the
 * crash and recovery specs receive through ZINNIA_E2E_CASE. The pre-state
 * manifest is written beside the case root, outside it, so it is not scanned.
 */
export function prepareCrashCase(profile, testCase) {
  const root = path.join(profile.work, "cases", testCase.id);
  fs.mkdirSync(root, { recursive: true });
  const info = {
    id: testCase.id,
    operation: testCase.operation,
    point: testCase.point,
    expect: testCase.expect,
    root,
    marker: path.join(root, "crash-marker.txt"),
    journal: journalPathForProfile(profile.profileDir),
    payloadText: profile.manifest.payloadText,
    payloadFile: profile.manifest.payloadFile,
  };
  if (testCase.operation === "extract") {
    const srcDir = path.join(root, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    info.archive = path.join(srcDir, "hello.7z");
    fs.copyFileSync(profile.copies["hello.7z"], info.archive);
    info.destination = path.join(root, "out");
    info.destinationMode = testCase.destination;
    if (testCase.destination === "preexisting") {
      fs.mkdirSync(info.destination, { recursive: true });
      fs.writeFileSync(path.join(info.destination, "keep.txt"), "keep-me\n");
    }
    info.afterOperation = path.join(root, "after");
  } else {
    const inputDir = path.join(root, "in");
    fs.mkdirSync(inputDir, { recursive: true });
    info.input = path.join(inputDir, "hello.txt");
    fs.writeFileSync(info.input, profile.manifest.payloadText);
    const outDir = path.join(root, "out");
    fs.mkdirSync(outDir, { recursive: true });
    info.output = path.join(outDir, "archive.7z");
    info.outputMode = testCase.output;
    if (testCase.output === "existing") {
      const oldDir = path.join(root, "old");
      fs.mkdirSync(oldDir, { recursive: true });
      fs.writeFileSync(
        path.join(oldDir, "old.txt"),
        "previous archive contents\n",
      );
      run7z(requireHostSidecar(), ["a", "-t7z", info.output, "--", "old.txt"], {
        cwd: oldDir,
      });
    }
    info.afterOperation = path.join(root, "after.7z");
  }
  info.preManifest = treeManifest(root);
  info.preManifestFile = path.join(
    profile.work,
    "cases",
    `${testCase.id}.pre.json`,
  );
  writeJson(info.preManifestFile, info.preManifest);
  return info;
}

/**
 * Seed a journal from a newer Zinnia build (format_version 99) that points at
 * real files, so any file touch by recovery would be visible in the manifests.
 */
export function prepareNewerJournal(profile) {
  const root = path.join(profile.work, "newer-journal");
  const stage = path.join(root, `.zinnia-extract-${"a".repeat(32)}`);
  const destination = path.join(root, "destination");
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "staged.txt"), "staged by newer build\n");
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "keep.txt"), "keep-me\n");
  const journal = {
    format_version: 99,
    stage,
    destination,
    archive: false,
    extract_stage_placement: "inside_destination",
    move_plan_sidecar: true,
    previous_archive_family: [],
    extract_phase: "in_progress",
  };
  const file = journalPathForProfile(profile.profileDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(journal, null, 2)}\n`);
  return {
    root,
    stage,
    destination,
    journal: file,
    preManifest: treeManifest(root),
  };
}

/** Write one evidence record as JSON and echo it into the suite log. */
export function writeEvidence(evidenceDir, name, record) {
  if (!evidenceDir) throw new Error("ZINNIA_E2E_EVIDENCE_DIR is not set");
  writeJson(path.join(evidenceDir, `${name}.json`), record);
  console.log(`ZINNIA_E2E_EVIDENCE ${JSON.stringify(record)}`);
}

/** Merge per-phase evidence files into one sorted sibling JSON. */
export function collectEvidence(evidenceDir) {
  if (!fs.existsSync(evidenceDir)) return [];
  return fs
    .readdirSync(evidenceDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      JSON.parse(fs.readFileSync(path.join(evidenceDir, name), "utf8")),
    );
}
