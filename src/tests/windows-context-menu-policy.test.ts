import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootManifestPath = path.resolve(
  process.cwd(),
  "src-tauri/windows/sparse-package/AppxManifest.xml.template",
);
const extractManifestPath = path.resolve(
  process.cwd(),
  "src-tauri/windows/sparse-package/ExtractAppxManifest.xml.template",
);
const rootManifest = fs.readFileSync(rootManifestPath, "utf8");
const extractManifest = fs.readFileSync(extractManifestPath, "utf8");
const shellSource = fs.readFileSync(
  path.resolve(process.cwd(), "src-tauri/windows/shell/dllmain.cpp"),
  "utf8",
);
const openRoutingSource = fs.readFileSync(
  path.resolve(process.cwd(), "src-tauri/src/launch/open_routing.rs"),
  "utf8",
);
const supportedArchiveTypes = [
  ".7z",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".001",
];

function itemTypeBody(manifest: string, type: string): string {
  const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = manifest.match(
    new RegExp(
      `<desktop5:ItemType Type="${escaped}">([\\s\\S]*?)<\\/desktop5:ItemType>`,
    ),
  );
  expect(match, `missing ItemType ${type}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("Windows 11 context-menu manifest", () => {
  it("separates Root and Extract into distinct app identities", () => {
    expect(rootManifest).toContain('Name="run.rosie.zinnia.contextmenu"');
    expect(extractManifest).toContain('Name="run.rosie.zinnia.extractmenu"');
    expect(rootManifest).not.toContain("ZinniaExtract");
    expect(extractManifest).not.toContain("ZinniaRoot");
    expect(rootManifest).toContain('Executable="zinnia.exe"');
    expect(extractManifest).toContain('Executable="zinnia.exe"');
    expect(rootManifest).toContain(
      'Path="__SHELL_DIRECTORY__\\zinnia_shell.dll"',
    );
    expect(extractManifest).toContain(
      'Path="__SHELL_DIRECTORY__\\zinnia_extract_shell.dll"',
    );
  });

  it("does not register the extraction command as a file opener", () => {
    expect(extractManifest).not.toContain("windows.fileTypeAssociation");
    expect(extractManifest).not.toContain("FileTypeAssociation");
    expect(extractManifest).not.toContain("SupportedFileTypes");
  });

  it("keeps wildcard registration to one root verb", () => {
    const wildcard = itemTypeBody(rootManifest, "*");
    expect(wildcard).toContain('Id="ZinniaRoot"');
    expect(wildcard).not.toContain("ZinniaExtract");
    expect(wildcard.match(/<desktop5:Verb\b/g)).toHaveLength(1);
  });

  it("registers one top-level extract verb for every supported archive type", () => {
    for (const type of supportedArchiveTypes) {
      const body = itemTypeBody(extractManifest, type);
      expect(body).toContain("ZinniaExtract");
      expect(body).not.toContain("ZinniaRoot");
      expect(body.match(/<desktop5:Verb\b/g)).toHaveLength(1);
    }
  });

  it("builds, bundles, signs, and registers both sparse packages", () => {
    const read = (file: string) =>
      fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
    const build = read("scripts/build-windows-context-menu.ps1");
    const stubs = read("scripts/ensure-windows-context-menu-stubs.mjs");
    const tauriBuild = read("scripts/tauri-windows-build.js");
    const verify = read("scripts/verify-windows-authenticode.ps1");
    const sign = read("scripts/windows-artifact-sign.ps1");
    const tauriConfig = read("src-tauri/tauri.windows.conf.json");
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    const packageConsumers = [
      build,
      stubs,
      tauriBuild,
      verify,
      sign,
      tauriConfig,
    ];

    for (const contents of packageConsumers) {
      expect(contents).toContain("ZinniaContextMenu.msix");
      expect(contents).toContain("ZinniaExtractContextMenu.msix");
    }
    for (const contents of [build, stubs, tauriBuild, verify, tauriConfig]) {
      expect(contents).toContain("zinnia_shell.dll");
      expect(contents).toContain("zinnia_extract_shell.dll");
    }
    expect(stubs).toContain('includes("--force")');
    expect(tauriBuild).toContain('"--force"');
    expect(packageJson.scripts["prepare:win-shell-stubs"]).toContain("--force");

    const registration = read("scripts/register-windows-context-menu.ps1");
    expect(registration).toContain("$MsixPath");
    expect(registration).toContain("$ExtractMsixPath");
    expect(registration).toContain("run.rosie.zinnia.contextmenu");
    expect(registration).toContain("run.rosie.zinnia.extractmenu");
  });

  it("installs shell payloads side by side so updates cannot overwrite loaded DLLs", () => {
    const read = (file: string) =>
      fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
    const tauriConfig = JSON.parse(
      read("src-tauri/tauri.windows.conf.json"),
    ) as {
      bundle: { resources: Record<string, string> };
    };
    const packageVersion = (
      JSON.parse(read("package.json")) as { version: string }
    ).version;
    const hooks = read("src-tauri/windows/nsis-hooks.nsh");

    const shellDestinations = Object.entries(tauriConfig.bundle.resources)
      .filter(([source]) => source !== "binaries/7z.dll")
      .map(([, destination]) => destination);
    for (const destination of shellDestinations) {
      expect(destination.startsWith(`shell-${packageVersion}/`)).toBe(true);
      expect(destination).not.toContain("${VERSION}");
    }
    expect(tauriConfig.bundle.resources["binaries/7z.dll"]).toBe("7z.dll");
    expect(hooks).toContain('StrCpy $R9 "$INSTDIR\\shell-${VERSION}"');
    expect(hooks).toContain("!macro NSIS_HOOK_PREINSTALL");
    expect(hooks).toContain("!macro NSIS_HOOK_PREUNINSTALL");
    expect(hooks).toContain("!macro NSIS_HOOK_POSTUNINSTALL");
    expect(hooks).toContain("zinnia_preinstall_check_reparse");
    expect(hooks).toContain(
      "cannot install into a shell directory that is a junction or symbolic link",
    );
    expect(hooks).toContain("SetOverwrite ifdiff");
    expect(hooks).toContain("SetOverwrite on");
    expect(hooks).toContain("!macro NSIS_HOOK_PREUNINSTALL");
    expect(hooks).toContain("zinnia_preuninstall_abort");
    expect(hooks).toContain("/UPDATE");
    expect(hooks).toContain("Get-AppxPackage");
    expect(hooks).toContain(
      '!insertmacro ZINNIA_REGISTER_CLASSIC_EXTRACT ".rar"',
    );
    expect(hooks).toContain(
      '!insertmacro ZINNIA_REGISTER_CLASSIC_EXTRACT ".001"',
    );
    expect(hooks).toContain(
      "Uninstall was cancelled so Explorer can still find the shell files",
    );
    expect(hooks).toContain("!macro NSIS_HOOK_POSTUNINSTALL");
    expect(hooks).toContain("!macro ZINNIA_CLEAN_LEGACY_SHELL_PAYLOAD");
    expect(hooks).toContain('Delete /REBOOTOK "$INSTDIR\\zinnia_shell.dll"');
    expect(hooks).toContain("!macro ZINNIA_CLEAN_SHELL_PAYLOADS");
    expect(hooks).toContain('FindFirst $R8 $R9 "$INSTDIR\\shell-*"');
    expect(hooks).toContain("GetFileAttributesW");
    expect(hooks).toContain("& 0x400");
    expect(hooks).toContain(
      'Delete /REBOOTOK "$INSTDIR\\$R9\\zinnia_shell.dll"',
    );
    expect(hooks).toContain('RMDir /REBOOTOK "$INSTDIR\\$R9"');
    expect(hooks).not.toContain("RMDir /r");
    expect(hooks).toContain(
      '!insertmacro ZINNIA_CLEAN_SHELL_PAYLOADS "shell-${VERSION}"',
    );
    expect(hooks).toContain(
      '!insertmacro ZINNIA_CLEAN_SHELL_PAYLOADS "" zinnia_uninstall_shell_cleanup',
    );
    const postUninstall = hooks.slice(
      hooks.indexOf("!macro NSIS_HOOK_POSTUNINSTALL"),
    );
    expect(postUninstall).not.toContain("ZINNIA_UNREGISTER_WIN11_CONTEXT_MENU");
    expect(postUninstall).toContain(
      '!insertmacro ZINNIA_CLEAN_SHELL_PAYLOADS "" zinnia_uninstall_shell_cleanup',
    );
    const preUninstall = hooks.slice(
      hooks.indexOf("!macro NSIS_HOOK_PREUNINSTALL"),
      hooks.indexOf("!macro NSIS_HOOK_POSTUNINSTALL"),
    );
    expect(preUninstall).toContain("ZINNIA_UNREGISTER_WIN11_CONTEXT_MENU");
    expect(preUninstall).toMatch(/^\s*Abort\s*$/m);
    expect(preUninstall).toContain("IntCmp $R5 1 zinnia_preuninstall_abort");
    expect(hooks).toContain(
      'Delete /REBOOTOK "$INSTDIR\\zinnia-context-menu-register.log"',
    );
    expect(hooks).toContain('RMDir /REBOOTOK "$INSTDIR"');
    expect(hooks).not.toContain("zinnia_skip_instdir_rmdir");
    expect(hooks).not.toContain("taskkill");
    expect(hooks).toContain(
      '"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"',
    );
    expect(hooks).not.toContain("'powershell.exe -NoProfile");

    const registration = read("scripts/register-windows-context-menu.ps1");
    expect(registration).toContain("Remove-StaleShellPayloads");
    expect(registration).toContain("[StringComparer]::OrdinalIgnoreCase");
    expect(registration).toContain("scheduling installer cleanup");
    expect(registration).toContain(
      "refusing to clean reparse-point shell directory",
    );
    expect(registration).toContain(
      "ShellPayloadLocation must not be a reparse point",
    );
    expect(registration).not.toContain("-Recurse");
    expect(registration).toContain("Find-PreviousShellPayloads");
    expect(registration).toContain("Convert-ShellPayloadSortKey");
    expect(registration).toContain("Sort-Object -Property SortKey");
    expect(registration).not.toContain("SortName");
    expect(registration).toContain("Assert-PayloadAuthenticode");
    expect(registration).toContain("Get-AuthenticodeSignature");
    expect(registration).toContain(
      "Previous Win11 context-menu packages were restored",
    );
    expect(registration).toContain("Restore-PreviousShellPackages");
    expect(registration).toContain("Restoring previous packages from");
    expect(registration).toContain("-ForceUpdateFromAnyVersion");
    expect(registration).toContain("Unregister-ZinniaShellPackages");
    expect(registration).toContain("[switch]$Unregister");
    expect(registration).not.toContain(
      "if ($previousPayload -and $hadPreviousPackages)",
    );
    expect(registration).toContain("Could not write registration log");
    expect(registration).toContain("Could not reset registration log");
    expect(registration).toContain("$attempt -lt 5");
    expect(hooks).toContain('StrCmp $0 "error"');
    expect(registration).toContain(
      "Cleanup of stale shell payloads was deferred",
    );

    const cmake = read("src-tauri/windows/shell/CMakeLists.txt");
    expect(cmake).toContain("MSVC_RUNTIME_LIBRARY");
    expect(cmake).toContain("MultiThreaded");

    const build = read("scripts/build-windows-context-menu.ps1");
    expect(build).toContain("windows-vs-toolchain.ps1");
    expect(build).toContain("Resolve-ZinniaCmakeExecutable");
    expect(build).toContain("print-windows-package-version.js");
    expect(build).toContain("Replace('__SHELL_DIRECTORY__', $shellDirectory)");
    expect(build).toContain("Assert-NoTemplateTokens $appxText");
    expect(build).toContain("Assert-NoTemplateTokens $extractAppxText");
    expect(build).toContain("Assert-NoTemplateTokens $identityText");
    expect(build).toContain("Assert-NoTemplateTokens $extractIdentityText");
    expect(build).not.toContain("-replace '[^0-9.]'");
    expect(hooks).toContain('-ExternalLocation "$INSTDIR"');
    expect(hooks).toContain('-ShellPayloadLocation "$R9"');
    expect(registration).toContain("$ShellPayloadLocation");
    expect(registration).toContain(
      "Application executable not found in ExternalLocation",
    );
    expect(registration).toContain(
      "Remove-StaleShellPayloads -CurrentLocation $ShellPayloadLocation",
    );
  });

  it("keeps archive filtering fast on Explorer's menu-construction path", () => {
    expect(shellSource).toContain('stem_os + L".002"');
    expect(shellSource).toContain('if (suffix != L"001") return false;');
    expect(shellSource).not.toContain("volume <= 999");
  });

  it("retries Win11 sparse package removal and warns if packages remain", () => {
    const hooks = fs.readFileSync(
      path.resolve(process.cwd(), "src-tauri/windows/nsis-hooks.nsh"),
      "utf8",
    );
    const unregister = hooks.slice(
      hooks.indexOf("!macro ZINNIA_UNREGISTER_WIN11_CONTEXT_MENU"),
      hooks.indexOf("!macro ZINNIA_CLEAN_SHELL_PAYLOADS"),
    );
    expect(unregister).toContain("-Unregister");
    expect(unregister).toContain('-File "$R8"');
    expect(unregister).toContain('StrCmp $0 "error"');
    expect(unregister).toContain("zinnia_win11_unregister_ok");
    expect(unregister).toContain(
      "Could not fully unregister Win11 sparse context-menu packages",
    );
    expect(unregister).toContain("Pop $0");
    expect(unregister).toContain("IntCmp $0 0 zinnia_win11_unregister_ok");
    expect(unregister).toContain('StrCpy $R5 "1"');
  });

  it("avoids stacking classic HKCU verbs on top of Win11 package verbs", () => {
    const hooks = fs.readFileSync(
      path.resolve(process.cwd(), "src-tauri/windows/nsis-hooks.nsh"),
      "utf8",
    );
    // Leftover SystemFileAssociations Open/Extract from earlier betas must be
    // purged on every install; ProgId open is the only Open with Zinnia source.
    expect(hooks).toContain("!macro ZINNIA_CLEAN_LEGACY_ARCHIVE_VERBS EXT");
    expect(hooks).toContain("!macro ZINNIA_REGISTER_PROGID_OPEN EXT");
    expect(hooks).toContain("!macro ZINNIA_REGISTER_CLASSIC_EXTRACT EXT");
    expect(hooks).toContain(
      'DeleteRegKey HKCU "Software\\Classes\\SystemFileAssociations\\${EXT}\\shell\\ZinniaOpen"',
    );
    expect(hooks).not.toContain(
      'WriteRegStr HKCU "Software\\Classes\\SystemFileAssociations\\${EXT}\\shell\\ZinniaOpen"',
    );
    // Win11 sparse packages also appear under Show more options. Classic
    // Extract/Compress are fallback-only when package registration fails.
    expect(hooks).toContain('StrCpy $R6 "0"');
    expect(hooks).toContain('StrCpy $R6 "1"');
    expect(hooks).toContain("zinnia_postinstall_win11_ok");
    expect(hooks).toContain("ZINNIA_POSTINSTALL_CLASSIC_EXTRACT_FALLBACK");
    const postInstall = hooks.slice(
      hooks.indexOf("!macro NSIS_HOOK_POSTINSTALL"),
      hooks.indexOf("!macro NSIS_HOOK_PREUNINSTALL"),
    );
    expect(postInstall).toContain("ZINNIA_CLEAN_LEGACY_ARCHIVE_VERBS");
    expect(postInstall).toContain("ZINNIA_REGISTER_PROGID_OPEN");
    expect(postInstall).toContain("ZINNIA_REGISTER_COMPRESS_VERBS");
    expect(postInstall).toContain("ZINNIA_REGISTER_WIN11_CONTEXT_MENU");
    expect(postInstall).toContain("ZINNIA_UNREGISTER_COMPRESS_VERBS");
    expect(postInstall).toContain(
      "ZINNIA_POSTINSTALL_CLASSIC_EXTRACT_FALLBACK",
    );
    expect(
      postInstall.indexOf("ZINNIA_CLEAN_LEGACY_ARCHIVE_VERBS"),
    ).toBeLessThan(postInstall.indexOf("ZINNIA_REGISTER_PROGID_OPEN"));
    expect(
      postInstall.indexOf("ZINNIA_REGISTER_WIN11_CONTEXT_MENU"),
    ).toBeLessThan(postInstall.indexOf("zinnia_postinstall_win11_ok"));
  });

  it("routes every complete filesystem selection through one durable handoff", () => {
    const hooks = fs.readFileSync(
      path.resolve(process.cwd(), "src-tauri/windows/nsis-hooks.nsh"),
      "utf8",
    );
    expect(
      hooks.match(/MultiSelectModel" "Player"/g)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(shellSource).toContain("resolved != count");
    expect(shellSource).toContain("ERROR_NOT_SUPPORTED");
    expect(shellSource).toContain(
      "if (count > 0) return GetSelectedPaths(selection, paths);",
    );
    expect(shellSource).toContain("WriteShellHandoff");
    expect(shellSource).toContain("--zinnia-shell-handoff");
    expect(shellSource).toContain("kMaxHandoffBytes = 4 * 1024 * 1024");
    expect(shellSource).toContain("CREATE_NEW");
    expect(shellSource).toContain(
      "ConvertStringSecurityDescriptorToSecurityDescriptorW",
    );
    expect(shellSource).toContain("D:P(A;OICI;FA;;;");
    expect(shellSource).toContain("IsValidWindowsSidString");
    expect(shellSource).not.toContain("GetTempFileNameW");
    expect(shellSource).not.toContain("kMaxPathsPerBatch");
    expect(shellSource).not.toContain("kSafeParameterChars");
    expect(shellSource).toContain("kMaxPathsPerRequest = 4'096");
    expect(shellSource).toContain("count > kMaxPathsPerRequest");
    expect(shellSource).toContain("selectionCount > kMaxPathsPerRequest");
    expect(openRoutingSource).toContain("MAX_PENDING_PATHS: usize = 4_096");
    expect(openRoutingSource).toContain(
      "MAX_SHELL_HANDOFF_BYTES: u64 = 4 * 1024 * 1024",
    );
    expect(openRoutingSource).toContain("parse_shell_handoff_contents");
    expect(openRoutingSource).toContain(
      "open_regular_file_nofollow_for_snapshot",
    );
    expect(openRoutingSource).toContain("assert_handle_owned_by_current_user");
    expect(openRoutingSource).toContain("--zinnia-shell-handoff");
    expect(openRoutingSource).toContain(
      "total_paths + paths.len() > MAX_PENDING_PATHS",
    );
    expect(shellSource).toContain("LaunchOneBatch");
    expect(shellSource).toContain("QuoteArgument");
    expect(shellSource).toContain("DirectoryNameStartsWithShellDash");
    expect(shellSource).toContain("if (length == 0) return std::wstring();");
    expect(shellSource).not.toContain('if (length == 0) return L"zinnia.exe";');
  });
});
