#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const cargoManifestPath = join(repoRoot, "src-tauri", "Cargo.toml");
const outputPath = join(repoRoot, "public", "licenses-cargo.json");

function runCargoMetadata() {
  const args = [
    "metadata",
    "--manifest-path",
    cargoManifestPath,
    "--format-version",
    "1",
  ];
  const result = spawnSync("cargo", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Failed to run cargo metadata: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `cargo metadata failed with exit code ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  }

  return JSON.parse(result.stdout);
}

function computeReachablePackageIds(metadata) {
  const workspaceMembers = new Set(
    Array.isArray(metadata.workspace_members) ? metadata.workspace_members : [],
  );
  const resolveNodes = Array.isArray(metadata.resolve?.nodes)
    ? metadata.resolve.nodes
    : [];
  const nodesById = new Map(resolveNodes.map((node) => [node.id, node]));

  const queue = [...workspaceMembers];
  const reachable = new Set(queue);

  while (queue.length > 0) {
    const id = queue.shift();
    const node = nodesById.get(id);
    if (!node || !Array.isArray(node.deps)) continue;

    for (const dep of node.deps) {
      const depId = typeof dep?.pkg === "string" ? dep.pkg : null;
      if (!depId || reachable.has(depId)) continue;
      reachable.add(depId);
      queue.push(depId);
    }
  }

  return { reachable, workspaceMembers };
}

function readLicenseTexts(pkg) {
  const packageDir = dirname(pkg.manifest_path);
  const names = new Set(
    readdirSync(packageDir).filter((name) =>
      /^(license|copying|notice|authors|copyright)(?:[._-].*)?$/i.test(name),
    ),
  );
  if (typeof pkg.license_file === "string" && pkg.license_file.trim()) {
    const filePath = resolve(packageDir, pkg.license_file);
    const rel = relative(packageDir, filePath);
    if (
      !rel.startsWith("..") &&
      !rel.includes("../") &&
      !rel.includes("..\\") &&
      existsSync(filePath)
    ) {
      names.add(rel);
    }
  }
  const sections = [];
  for (const name of [...names].sort()) {
    const text = readFileSync(join(packageDir, name), "utf8").trim();
    // AUTHORS/COPYRIGHT files are useful only when they also carry the
    // package's license terms. Do not surface an unrelated contributor list.
    const attributionOnly = /^(authors|copyright)(?:[._-].*)?$/i.test(name);
    const hasLicenseTerms =
      /permission is hereby granted|licensed under|gnu (?:lesser )?general public license|mozilla public license|redistribution and use/i.test(
        text,
      );
    if (text && (!attributionOnly || hasLicenseTerms)) {
      sections.push(`--- ${name} ---\n${text}`);
    }
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}

function spdxReferences(licenses) {
  const identifiers = licenses.match(/[A-Za-z0-9.-]+(?:\+)?/g) ?? [];
  return [...new Set(identifiers)]
    .filter(
      (identifier) =>
        !["AND", "OR", "WITH", "LicenseRef"].includes(identifier) &&
        !identifier.startsWith("DocumentRef-"),
    )
    .map((identifier) => ({
      identifier,
      url: `https://spdx.org/licenses/${encodeURIComponent(identifier)}.html`,
    }));
}

function toLicenseEntry(pkg) {
  const licenses =
    typeof pkg.license === "string" && pkg.license.trim()
      ? pkg.license.trim()
      : "UNKNOWN";
  if (licenses === "UNKNOWN") {
    throw new Error(
      `Cargo dependency ${pkg.name}@${pkg.version} does not declare an SPDX license.`,
    );
  }

  const bundledText = readLicenseTexts(pkg);
  const entry = {
    licenses,
    repository:
      typeof pkg.repository === "string" && pkg.repository.trim()
        ? pkg.repository.trim()
        : null,
    packageManager: "cargo",
    // Never borrow a license blob from another crate: copyright notices and
    // SPDX AND/OR expressions are package-specific. If a published crate does
    // not include its own text, preserve that fact and link to the declared
    // SPDX identifiers instead of fabricating attribution.
    licenseText: bundledText,
    licenseTextStatus: bundledText ? "bundled" : "not-packaged",
    licenseReferences: bundledText ? [] : spdxReferences(licenses),
  };

  if (Array.isArray(pkg.authors) && pkg.authors.length > 0) {
    const joined = pkg.authors
      .filter((author) => typeof author === "string" && author.trim())
      .join(", ");
    if (joined) {
      entry.publisher = joined;
    }
  }

  if (typeof pkg.source === "string" && pkg.source.trim()) {
    entry.source = pkg.source.trim();
  }

  return entry;
}

function buildCargoLicenses(metadata) {
  const { reachable, workspaceMembers } = computeReachablePackageIds(metadata);
  const packages = Array.isArray(metadata.packages) ? metadata.packages : [];

  const reachablePackages = packages.filter(
    (pkg) =>
      pkg &&
      typeof pkg.id === "string" &&
      reachable.has(pkg.id) &&
      !workspaceMembers.has(pkg.id) &&
      typeof pkg.name === "string" &&
      typeof pkg.version === "string",
  );
  const entries = {};
  for (const pkg of reachablePackages) {
    const key = `cargo:${pkg.name}@${pkg.version}`;
    entries[key] = toLicenseEntry(pkg);
  }

  return Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function main() {
  const metadata = runCargoMetadata();
  const licenses = buildCargoLicenses(metadata);
  const missingText = Object.values(licenses).filter(
    (entry) => entry.licenseTextStatus === "not-packaged",
  ).length;

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(licenses, null, 2)}\n`, "utf8");
  console.log(
    `[licenses:cargo] Wrote ${Object.keys(licenses).length} cargo entries to ${outputPath} (${missingText} package license texts unavailable; SPDX references included)`,
  );
}

main();
