import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "../..");

function source(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function sectionAfter(sourceText, start) {
  const startIndex = sourceText.search(start);
  if (startIndex < 0) return null;
  const bodyStart = sourceText.indexOf("{", startIndex);
  if (bodyStart < 0) return null;
  let depth = 0;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    if (sourceText[index] === "{") depth += 1;
    else if (sourceText[index] === "}") {
      depth -= 1;
      if (depth === 0) return sourceText.slice(startIndex, index + 1);
    }
  }
  return null;
}

function stripTestOnlyBlocks(sourceText) {
  let output = "";
  let cursor = 0;
  while (cursor < sourceText.length) {
    const marker = sourceText.indexOf("#[cfg(test)]", cursor);
    if (marker < 0) {
      output += sourceText.slice(cursor);
      break;
    }
    output += sourceText.slice(cursor, marker);
    const bodyStart = sourceText.indexOf("{", marker);
    if (bodyStart < 0) break;
    let depth = 0;
    let bodyEnd = bodyStart;
    for (; bodyEnd < sourceText.length; bodyEnd += 1) {
      if (sourceText[bodyEnd] === "{") depth += 1;
      else if (sourceText[bodyEnd] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    cursor = bodyEnd + 1;
  }
  return output;
}

function check(name, ok, detail) {
  return { name, ok, detail: ok ? "ok" : detail };
}

export function checkArchiveIoStructure(root = REPO_ROOT) {
  const staging = source(root, "src-tauri/src/process/staging.rs");
  const commit = source(root, "src-tauri/src/process/commit.rs");
  const commands = source(root, "src-tauri/src/process/commands.rs");
  const compressionPreflight = source(
    root,
    "src-tauri/src/process/compress_preflight.rs",
  );
  const quota = source(root, "src-tauri/src/process/quota.rs");
  const updateBranch = sectionAfter(staging, /Some\("u"\)\s*=>/);
  const productionUpdateBranch = updateBranch
    ? stripTestOnlyBlocks(updateBranch)
    : null;
  const publishFunction = sectionAfter(
    commit,
    /fn\s+merge_staged_extract_recorded\s*</,
  );
  const manifestFunction = sectionAfter(
    staging,
    /fn\s+parse_slt_archive_manifest\s*\(/,
  );
  const compressionFunction = sectionAfter(
    commands,
    /fn\s+assert_compress_inputs_are_real_paths\s*</,
  );
  const compressionWalkFunction = sectionAfter(
    compressionPreflight,
    /fn\s+walk_path\s*</,
  );
  const compressionRegularFileBypass = compressionFunction
    ? sectionAfter(compressionFunction, /if\s*!needs_recursive_probe\s*\{/)
    : null;
  const targetLocalPlanning = sectionAfter(
    commit,
    /fn\s+prepare_target_local_publish_paths\s*\(/,
  );
  const checks = [];

  checks.push(
    check(
      "update uses separate-output mode",
      productionUpdateBranch != null &&
        !/std::fs::copy\s*\(\s*&target\s*,\s*&staged\s*\)/.test(
          productionUpdateBranch,
        ) &&
        /(?:-u-|separate.{0,24}output|staged.{0,24}update|update.{0,24}staged)/is.test(
          `${productionUpdateBranch}\n${commands}`,
        ),
      "update branch still pre-copies archive or has no separate-output update marker",
    ),
  );

  const missingDestinationPublish = publishFunction
    ? sectionAfter(publishFunction, /if\s*!path_entry_exists\(destination\)/)
    : null;
  const fingerprintCount = missingDestinationPublish
    ? (
        missingDestinationPublish.match(
          /path_identity_with_fingerprint\s*\(/g,
        ) ?? []
      ).length
    : -1;
  checks.push(
    check(
      "publish phase has no duplicate whole-tree fingerprint",
      fingerprintCount >= 0 && fingerprintCount <= 2,
      `missing-destination publish has ${fingerprintCount} whole-tree fingerprint calls; expected at most 2`,
    ),
  );

  const strategyBehavior =
    /enum\s+PublishStrategy\s*\{[\s\S]*WholeStageRename[\s\S]*DirectRename[\s\S]*TargetLocalCopy[\s\S]*HardLinkFallback[\s\S]*CopyFallback/.test(
      commit,
    ) &&
    /PublishStrategy::DirectRename/.test(commit) &&
    /PublishStrategy::WholeStageRename/.test(commit) &&
    /PublishStrategy::TargetLocalCopy/.test(commit) &&
    /publish_target_local_copy\s*\(/.test(commit) &&
    /rename_file_no_replace\s*\(/.test(commit) &&
    /copy_file_no_replace_with_created\s*\(/.test(commit);
  checks.push(
    check(
      "publish strategy classifies fast and fallback paths",
      strategyBehavior,
      "publish strategy does not bind explicit fast/fallback variants to real rename/copy calls",
    ),
  );

  const manifestBehavior =
    manifestFunction != null &&
    /summary\.entry_count/.test(manifestFunction) &&
    /summary\.path_bytes/.test(manifestFunction) &&
    /summary\.declared_bytes/.test(manifestFunction) &&
    /summary\.has_symbolic_links/.test(manifestFunction) &&
    /summary\.has_hard_links/.test(manifestFunction) &&
    /MAX_EXTRACT_ENTRIES/.test(manifestFunction) &&
    /MAX_EXTRACT_PATH_BYTES/.test(manifestFunction) &&
    /parse::<u64>\(\)\.map_err/.test(manifestFunction) &&
    /checked_add/.test(manifestFunction);
  checks.push(
    check(
      "manifest preflight returns bounded bytes/count/path/link summary",
      manifestBehavior,
      "manifest parser lacks one or more checked aggregate counters or link classifications",
    ),
  );

  const quotaCalls = [
    ...commands.matchAll(/monitor_extract_quota(?:_with_manifest)?\s*\(/g),
  ].map((match) => {
    return commands.slice(match.index, match.index + 900);
  });
  checks.push(
    check(
      "quota monitor receives manifest headroom",
      quotaCalls.length > 0 &&
        quotaCalls.some((call) =>
          /manifest|headroom|declared|summary/i.test(call),
        ) &&
        /skip_recursive_scans|summary\.declared_bytes/i.test(quota),
      "quota monitor invocation has no manifest/headroom input; recursive scans remain unconditional",
    ),
  );

  checks.push(
    check(
      "quota headroom bypass retains final authoritative validation",
      /monitor_extract_quota_with_manifest/.test(commands) &&
        /skip_recursive_scans/.test(quota) &&
        /!summary\.has_links\(\)/.test(quota) &&
        /summary\.declared_bytes\s*<=\s*max_bytes\s*\/\s*2/.test(quota) &&
        /summary\.entry_count/.test(quota) &&
        /summary\.path_bytes/.test(quota) &&
        /validate_and_sync_staged_tree\s*\(/.test(commit),
      "manifest headroom bypass or final pre-publish validation is missing",
    ),
  );

  checks.push(
    check(
      "link-free existing destinations can use inside staging safely",
      /create_publish_stage_dir_inside/.test(commands) &&
        /extract_manifest[\s\S]*!manifest\.has_links\(\)/.test(commands) &&
        /relocate_extract_stage_inside_destination/.test(commands) &&
        /link-bearing-sibling-safety/.test(commands),
      "inside-destination staging is not visibly gated by the preflight link summary",
    ),
  );

  checks.push(
    check(
      "common inside-stage roots avoid target-local copies",
      targetLocalPlanning != null &&
        /allow_direct_root_rename\s*&&/.test(targetLocalPlanning) &&
        /record\.target\.parent\(\)\s*==\s*Some\(destination\)/.test(
          targetLocalPlanning,
        ) &&
        /continue;/.test(targetLocalPlanning) &&
        /record\.publish_temp\s*=\s*Some/.test(targetLocalPlanning),
      "target-local planning does not distinguish direct roots from nested/custom-policy fallbacks",
    ),
  );

  checks.push(
    check(
      "inside-stage diagnostics distinguish policy fallback",
      /sibling-stage-existing-destination-fallback/.test(commands) &&
        /stage\.parent\(\)\s*==\s*Some\(destination\.as_path\(\)\)/.test(
          commands,
        ),
      "inside-stage selection reports the attempted optimization even when stage creation falls back",
    ),
  );

  const compressionBehavior =
    compressionFunction != null &&
    /meta\.is_file\(\)/.test(compressionFunction) &&
    /meta\.is_dir\(\)/.test(compressionFunction) &&
    /needs_recursive_probe/.test(compressionFunction) &&
    compressionRegularFileBypass != null &&
    !/assert_compress_inputs_safe_with_cancel/.test(
      compressionRegularFileBypass,
    ) &&
    /return\s+Ok\s*\(\s*(?:\(\)|CompressInputPreflight\s*\{[\s\S]*?input_scan_ms\s*:\s*elapsed_ms\(input_scan_started\)[\s\S]*?\})\s*\)/.test(
      compressionRegularFileBypass,
    );
  checks.push(
    check(
      "compression preflight can classify regular-file inputs",
      compressionBehavior && /probe_compress_input_paths/.test(commands),
      "compression preflight has no behavior-bearing regular-file bypass",
    ),
  );

  const compressionReplacementSafety =
    compressionWalkFunction != null &&
    /accounted\s*:\s*bool/.test(compressionPreflight) &&
    /symlink_metadata\(\s*&path\s*\)/.test(compressionWalkFunction) &&
    /symlink_metadata\(\s*&path\s*\)[\s\S]{0,900}classify_link\(\s*&path/.test(
      compressionWalkFunction,
    );
  checks.push(
    check(
      "compression preflight rechecks queued directories before traversal",
      compressionReplacementSafety,
      "parallel compression probing can authorize recursion from stale child metadata",
    ),
  );

  return checks;
}

export function formatChecks(checks) {
  return checks
    .map(
      (item) =>
        `${item.ok ? "PASS" : "FAIL"} ${item.name}${item.ok ? "" : `: ${item.detail}`}`,
    )
    .join("\n");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const checks = checkArchiveIoStructure();
  console.log(formatChecks(checks));
  if (checks.some((item) => !item.ok)) process.exit(1);
}
