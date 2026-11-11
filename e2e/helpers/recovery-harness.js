import { execFileSync } from "node:child_process";
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
/**
 * Seed a journal from an older Zinnia build (format_version 0) that points at
 * real files, so any file touch by recovery would be visible in the manifests.
 */
export function prepareOlderJournal(profile) {
  const root = path.join(profile.work, "older-journal");
  const stage = path.join(root, `.zinnia-extract-${"b".repeat(32)}`);
  const destination = path.join(root, "destination");
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "staged.txt"), "staged by older build\n");
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "keep.txt"), "keep-me\n");
  const journal = {
    format_version: 0,
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

export const PENDING_REGISTRY_FILE = "pending-stages.json";
const UNREADABLE_REGISTRY = "{ not a pending-stage registry\n";

/**
 * Seed an unreadable pending-stage registry in the app cache dir, beside a
 * leaked stage directory that no record names. Startup must preserve the
 * registry bytes once and leave the stage alone.
 */
export function preparePendingRegistry(profile) {
  const root = path.join(profile.work, "pending-registry");
  const cacheDir = path.dirname(journalPathForProfile(profile.profileDir));
  const registry = path.join(cacheDir, PENDING_REGISTRY_FILE);
  const stage = path.join(root, `.zinnia-extract-${"d".repeat(32)}`);
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(
    path.join(stage, "staged.txt"),
    "leaked by an earlier build\n",
  );
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(registry, UNREADABLE_REGISTRY);
  return {
    root,
    cacheDir,
    registry,
    registrySha256: sha256File(registry),
    stage,
    stageManifest: treeManifest(stage),
    archive: profile.copies["hello.7z"],
    destination: path.join(root, "after-startup"),
    payloadFile: profile.manifest.payloadFile,
  };
}

// Pause point and archive for each cancel-race spec. The pause is long enough
// for WebDriver to click Cancel while the app is held at the point.
export const CANCEL_RACE_PAUSE_MS = 4000;
const CANCEL_RACE_CASES = {
  "cancel-race": {
    point: "member-preflight-spawned",
    source: (profile) => profile.copies["hello.7z"],
  },
  "cancel-race-compound": {
    point: "compound-tar-spawned",
    source: () => path.join(REPO_ROOT, "zips", "hello.tar.gz"),
  },
};

/**
 * Lay out one cancel-race case under the profile work dir. The pause marker
 * lives in the work dir, outside the case root, so it is not scanned for
 * leftovers, and it is removed so a stale file cannot satisfy the wait.
 */
export function prepareCancelRace(profile, caseId) {
  const testCase = CANCEL_RACE_CASES[caseId];
  if (!testCase) throw new Error(`unknown cancel-race case ${caseId}`);
  const source = testCase.source(profile);
  if (!fs.existsSync(source)) {
    throw new Error(`cancel-race fixture is missing: ${source}`);
  }
  const root = path.join(profile.work, caseId);
  const srcDir = path.join(root, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  const archive = path.join(srcDir, path.basename(source));
  fs.copyFileSync(source, archive);
  const marker = path.join(profile.work, `${caseId}.pause-marker`);
  fs.rmSync(marker, { force: true });
  return {
    id: caseId,
    point: testCase.point,
    pauseMs: CANCEL_RACE_PAUSE_MS,
    marker,
    root,
    archive,
    archiveSha256: sha256File(archive),
    destination: path.join(root, "cancelled-out"),
    rerunDestination: path.join(root, "rerun-out"),
    payloadFile: profile.manifest.payloadFile,
  };
}

/**
 * Live 7-Zip sidecar processes, as "pid command" lines. Zinnia passes the
 * archive to 7-Zip through a private listfile, so argv does not name the
 * archive; the executable name is the only stable signal.
 */
export function sevenZipProcesses(platform = process.platform) {
  if (platform === "win32") {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Get-CimInstance Win32_Process -Filter "Name LIKE \'7z%\'" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }',
      ],
      { encoding: "utf8" },
    );
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  const output = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
    encoding: "utf8",
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      const executable = line.replace(/^\d+\s+/, "").split(/\s+/)[0] ?? "";
      return path.basename(executable).startsWith("7z");
    });
}
