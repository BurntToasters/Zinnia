#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REVIEW_EXPIRES = "2026-12-01";
const REVIEWED_ADVISORIES = new Map([
  ["GHSA-GGR8-5VV4-36MX", "deepmerge-ts"],
  ["GHSA-JMR9-QJV8-65GV", "extract-zip"],
  ["GHSA-5C6J-R48X-RMVQ", "serialize-javascript"],
  ["GHSA-QJ8W-GFJ5-8C6V", "serialize-javascript"],
]);

function advisoryId(via) {
  if (!via || typeof via !== "object") return null;
  const text = `${via.url || ""} ${via.title || ""}`;
  return (
    text
      .match(
        /GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}/i,
      )?.[0]
      ?.toUpperCase() || null
  );
}

function collectAdvisories(name, vulnerabilities, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const vulnerability = vulnerabilities?.[name];
  if (!vulnerability) return [];
  const result = [];
  for (const via of Array.isArray(vulnerability.via) ? vulnerability.via : []) {
    if (typeof via === "string") {
      result.push(...collectAdvisories(via, vulnerabilities, seen));
      continue;
    }
    result.push({ packageName: name, advisory: via, id: advisoryId(via) });
  }
  return result;
}

function isDevOnlyNode(node, lock) {
  const entry = lock?.packages?.[node];
  return Boolean(entry && entry.dev === true);
}

function evaluateAudit(report, lock, now = new Date()) {
  const vulnerabilities = report?.vulnerabilities || {};
  const errors = [];
  const reviewed = new Map();
  const reviewExpired =
    now.getTime() >= Date.parse(`${REVIEW_EXPIRES}T00:00:00Z`);

  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    const nodes = Array.isArray(vulnerability?.nodes)
      ? vulnerability.nodes
      : [];
    if (nodes.length === 0) {
      errors.push(`${name}: npm audit did not report affected install nodes`);
    }
    for (const node of nodes) {
      if (!isDevOnlyNode(node, lock)) {
        errors.push(`${name}: affected node ${node} is not proven dev-only`);
      }
    }

    const advisories = collectAdvisories(name, vulnerabilities);
    if (advisories.length === 0) {
      errors.push(`${name}: vulnerability chain has no resolvable advisory`);
      continue;
    }
    for (const item of advisories) {
      if (!item.id) {
        errors.push(`${name}: advisory is missing a GHSA identifier`);
        continue;
      }
      const expectedPackage = REVIEWED_ADVISORIES.get(item.id);
      const actualPackage = String(
        item.advisory?.name || item.packageName || "",
      );
      if (!expectedPackage) {
        errors.push(`${name}: unreviewed advisory ${item.id}`);
        continue;
      }
      if (actualPackage !== expectedPackage) {
        errors.push(
          `${name}: ${item.id} expected ${expectedPackage}, npm reported ${actualPackage || "unknown package"}`,
        );
        continue;
      }
      reviewed.set(item.id, expectedPackage);
    }
  }

  if (reviewed.size > 0 && reviewExpired) {
    errors.push(
      `temporary dev-only advisory review expired on ${REVIEW_EXPIRES}; re-evaluate the WDIO/Mocha dependency graph`,
    );
  }

  return { errors, reviewed: [...reviewed.entries()] };
}

function runAudit(root) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["audit", "--json", "--audit-level=moderate"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  let report;
  try {
    report = JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(
      `npm audit did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.status !== 0 && !report.vulnerabilities) {
    throw new Error(
      `npm audit failed before producing a vulnerability report: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return report;
}

function main() {
  const root = path.join(__dirname, "..");
  const report = runAudit(root);
  const lock = JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  const { errors, reviewed } = evaluateAudit(report, lock);
  if (errors.length > 0) {
    for (const error of errors)
      console.error(`[npm-dev-audit] FAILED: ${error}`);
    process.exitCode = 1;
    return;
  }
  if (reviewed.length === 0) {
    console.log("[npm-dev-audit] No moderate-or-higher npm advisories found.");
    return;
  }
  console.warn(
    `[npm-dev-audit] Reviewed dev-only advisories (${reviewed.map(([id]) => id).join(", ")}); review expires ${REVIEW_EXPIRES}.`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      `[npm-dev-audit] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = {
  REVIEW_EXPIRES,
  REVIEWED_ADVISORIES,
  advisoryId,
  collectAdvisories,
  evaluateAudit,
  isDevOnlyNode,
};
