import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";

const args = process.argv.slice(2);
assertStableReleaseOverridesAllowed();
const skipWindowsCodeSigning = process.env.SKIP_WIN_CODESIGN?.trim() === "1";
const skipContextMenu = process.env.SKIP_WIN_CONTEXT_MENU?.trim() === "1";
const required = [
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_ARTIFACT_SIGNING_ENDPOINT",
  "AZURE_ARTIFACT_SIGNING_ACCOUNT",
  "AZURE_ARTIFACT_SIGNING_PROFILE",
  "AZURE_ARTIFACT_SIGNING_PUBLISHER",
];
const missing = skipWindowsCodeSigning
  ? []
  : required.filter((name) => !process.env[name]?.trim());
if (process.platform !== "win32")
  throw new Error("Signed Windows builds must run on Windows.");
if (missing.length)
  throw new Error(
    `Missing Artifact Signing environment variables: ${missing.join(", ")}`,
  );
// Full cert Subject is required for sparse MSIX + DLL <msix publisher> identity.
// CN-only fallback produces 0x8007000B when the Subject has O=/C= fields.
if (
  !skipWindowsCodeSigning &&
  !skipContextMenu &&
  !process.env.AZURE_ARTIFACT_SIGNING_PUBLISHER_DN?.trim()
) {
  throw new Error(
    "AZURE_ARTIFACT_SIGNING_PUBLISHER_DN is required for the Win11 context menu " +
      "(full signing certificate Subject). Copy from Azure Artifact Signing " +
      "profile Subject name, or: (Get-AuthenticodeSignature .\\zinnia.exe).SignerCertificate.Subject. " +
      "Set SKIP_WIN_CONTEXT_MENU=1 to skip the modern menu package.",
  );
}
if (skipWindowsCodeSigning)
  console.warn(
    "[tauri-windows-build] SKIP_WIN_CODESIGN=1; producing unsigned Windows artifacts.",
  );
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1] ?? "";
  return (
    args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? ""
  );
};
const target = valueAfter("--target");
if (!target.includes("windows"))
  throw new Error("A Windows --target is required.");
const root = fileURLToPath(new URL("..", import.meta.url));
const targetReleaseDir = path.join(
  root,
  "src-tauri",
  "target",
  target,
  "release",
);
const shellOutDir = path.join(root, "src-tauri", "windows", "shell", "out");
const shellDll = path.join(shellOutDir, "zinnia_shell.dll");
const extractShellDll = path.join(shellOutDir, "zinnia_extract_shell.dll");
const shellMsix = path.join(shellOutDir, "ZinniaContextMenu.msix");
const extractShellMsix = path.join(
  shellOutDir,
  "ZinniaExtractContextMenu.msix",
);
const signScript = fileURLToPath(
  new URL("./windows-artifact-sign.ps1", import.meta.url),
);
const contextMenuScript = fileURLToPath(
  new URL("./build-windows-context-menu.ps1", import.meta.url),
);

const arch = target.includes("aarch64") ? "arm64" : "x64";

function runPowershell(scriptPath, extraArgs = []) {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...extraArgs,
    ],
    { stdio: "inherit", env: process.env },
  );
}

if (!skipContextMenu) {
  console.log(
    "[tauri-windows-build] Building Win11 context-menu shell package…",
  );
  runPowershell(contextMenuScript, [`-Arch`, arch]);
  if (
    !existsSync(shellDll) ||
    !existsSync(extractShellDll) ||
    !existsSync(shellMsix) ||
    !existsSync(extractShellMsix)
  ) {
    throw new Error(
      `Context menu artifacts missing under ${shellOutDir}. Set SKIP_WIN_CONTEXT_MENU=1 to skip.`,
    );
  }
  if (!skipWindowsCodeSigning) {
    console.log("[tauri-windows-build] Signing zinnia_shell.dll…");
    runPowershell(signScript, ["-FilePath", shellDll]);
    console.log("[tauri-windows-build] Signing zinnia_extract_shell.dll…");
    runPowershell(signScript, ["-FilePath", extractShellDll]);
    console.log("[tauri-windows-build] Signing ZinniaContextMenu.msix…");
    runPowershell(signScript, ["-FilePath", shellMsix, "-AllowSparseMsix"]);
    console.log("[tauri-windows-build] Signing ZinniaExtractContextMenu.msix…");
    runPowershell(signScript, [
      "-FilePath",
      extractShellMsix,
      "-AllowSparseMsix",
    ]);
  }
} else {
  console.warn(
    "[tauri-windows-build] SKIP_WIN_CONTEXT_MENU=1; embedding empty stub context-menu assets.",
  );
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("./ensure-windows-context-menu-stubs.mjs", import.meta.url),
      ),
      "--force",
    ],
    { stdio: "inherit" },
  );
}

const tauriCli = fileURLToPath(
  new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);
execFileSync(process.execPath, [tauriCli, "build", ...args, "--", "--locked"], {
  stdio: "inherit",
  env: process.env,
});
if (!skipWindowsCodeSigning) {
  const runtimeExecutables = readdirSync(targetReleaseDir, {
    withFileTypes: true,
  })
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"),
    )
    .map((entry) => path.join(targetReleaseDir, entry.name));
  if (!runtimeExecutables.length)
    throw new Error(
      `No final Windows runtime executables found under ${targetReleaseDir}`,
    );
  for (const executable of runtimeExecutables) {
    console.log(
      `[tauri-windows-build] Finalizing Authenticode signature: ${executable}`,
    );
    runPowershell(signScript, ["-FilePath", executable]);
  }
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(
        new URL("./verify-windows-authenticode.ps1", import.meta.url),
      ),
      "-TargetReleaseDir",
      targetReleaseDir,
    ],
    { stdio: "inherit", env: process.env },
  );
}
