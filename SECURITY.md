# Security Policy

## Reporting a vulnerability

Report security issues privately via GitHub's **Report a vulnerability** advisory
flow (Security tab) or by email to the maintainer. Please do not open public
issues for undisclosed vulnerabilities. Include reproduction steps and affected
version/platform.

## Threat model

Zinnia is a single-user desktop application. It runs the bundled 7-Zip binary as
a sidecar; it does not run a server or accept network input beyond the signed
update check.

### 7z argument boundary

All 7z invocations go through `validate_run_7z_args`
([`src-tauri/src/validation.rs`](src-tauri/src/validation.rs)), the security
boundary between frontend-supplied arguments and the spawned process:

- Only the commands `a`, `u`, `x`, `l`, `t`, `b` are permitted.
- A mandatory `--` separator divides switches from paths; switches are
  allow-listed by prefix.
- Null bytes and over-length arguments are rejected.
- Positional paths and the `-o` output directory may not contain a `..`
  parent-directory segment (defense-in-depth against path traversal, independent
  of frontend validation).
- Destructive `-sdel` operations are rejected. Users delete source files
  explicitly after verifying the archive.

Arguments are passed to the sidecar as an array, never via a shell string, so
command injection is not possible.

### Output transactions and extraction containment

Zinnia does not let 7-Zip write directly into the final output for mutating
operations:

- Create/update writes to a sibling staging basename. Only a successful process
  promotes the complete output family, including split volumes.
- Extraction writes to a contained staging directory. Before extraction, Zinnia
  copies the complete input volume family into a private, recovery-tracked
  snapshot. Member listing and extraction both use that same snapshot, so an
  ordinary source-file replacement cannot change what is extracted after
  preflight. Zinnia lists members (`7z l -slt`) and rejects paths with `..` or absolute
  forms that could escape the `-o` root into an existing sibling folder. Before
  promotion, Zinnia also snapshots sibling names in the stage parent (new names
  outside the stage fail closed), walks the staged tree, rejects absolute or
  escaping symbolic links and Windows reparse points (relative in-tree links
  used by macOS `.app` / `.framework` bundles are allowed), rejects unsupported
  file types, and applies entry-count and expanded-size ceilings.
- Create/update passes `-snl` / `-snh` so symbolic and hard links inside selected
  folders (for example macOS app bundles) are stored as links rather than
  followed. The backend also injects these switches on create/update so they
  cannot be omitted by the webview. The selected input path itself must still be
  a real file or directory (symlink/reparse inputs are rejected), except for
  relative symlink *members* under a managed convert temp directory (so Convert
  can round-trip top-level links). Nested Windows junctions / cloud placeholders
  inside a compress tree are rejected (fail closed); ZIP still cannot faithfully
  round-trip many symlink trees, so the UI warns when ZIP is chosen for inputs
  that contain symlinks or `.app` bundles - prefer `7z` or `tar`.
- `-sns` (NTFS alternate streams) and `-sni` (NT security descriptors) remain
  blocked: packing ADS / ACLs is a known hiding and privilege footgun.
- On Windows extract, Zinnia injects 7-Zip `-snz` so Mark-of-the-Web
  (`Zone.Identifier`) propagates from a downloaded archive onto extracted files
  (SmartScreen / Office Protected View). Zinnia does **not** strip MOTW.
- Promotion resolves file/directory conflicts without overwriting unrelated
  destination content. A durable move plan and transaction journal allow an
  interrupted merge or split-archive promotion to be rolled back on restart.
- Cancel/close keeps the global operation slot locked until the child has exited
  and staging cleanup has completed.
- Extraction growth is limited by both expansion ratio and current free disk
  space, with capacity reserved for the OS and other applications.

These checks are defense in depth around 7-Zip's own path sanitization. They do
not make untrusted archives harmless: users should still keep Zinnia and its
bundled 7-Zip current and avoid opening extracted executables they do not trust.

### Password handling

Zinnia removes `-pPASSWORD` before spawning 7-Zip and supplies the password to
7-Zip's prompt through a short-lived stdin pipe. Create/update receives a bare
`-p` switch so 7-Zip prompts instead of silently creating an unencrypted
archive; list/test/extract prompt automatically. The pipe is bounded and then
closed so an unexpected prompt cannot leave the sidecar waiting indefinitely.
The password is therefore not present in the spawned process's command line or
ordinary process listings.

Passwords are never written to the activity log, command preview, or persisted
settings (redacted via `sanitizeCommandArgsForPreview` /
`redactSensitiveText`). Passwords containing line breaks are rejected because
the prompt transport is line-oriented.

The password necessarily exists transiently in Zinnia and 7-Zip process memory
and in the OS pipe buffer. A process with sufficient same-user debugging or
memory-inspection access, a crash dump, or a compromised user session may still
recover it. This transport protects against incidental command-line disclosure;
it does not protect secrets from an attacker who can inspect or control the
running user account.

### Vendored 7-Zip binaries

The 7-Zip binaries in `assets/` are committed to the repository and checksummed
in `assets/7z-checksums.json`. Exact official source URLs, downloaded archive
hashes, versions, and extracted members are recorded in
`assets/7z-provenance.json`. Because they are bundled, a 7-Zip CVE fix
requires manually updating the binaries, regenerating checksums, and shipping a
new Zinnia release; there is no OS-level automatic update mechanism.

**Action:** watch the [7-Zip release page](https://www.7-zip.org/history.txt)
and [NVD vendor page](https://nvd.nist.gov/vuln/search/results?form_type=Basic&results_type=overview&query=7-zip&search_type=all)
for new advisories. When a new 7-Zip version addresses a security issue, update
`assets/` with the new binaries, run
`assets/7z-provenance.json` with the exact official archive URLs, archive
SHA-256 values, and extracted member mapping, then run
`node scripts/prepare-7z.js --update-checksums --all --version <verified-version> --verify-downloads <download-directory> --trusted-7z <independently-trusted-7z-path>`
and cut a Zinnia release. The update command refuses to run when its explicit
version does not match the reviewed provenance manifest or the downloaded
archives and extracted members do not match that manifest. The trusted
extractor must be an independently installed file outside this repository's
candidate `assets/` and generated `src-tauri/binaries/` roots; it is used only
to unpack the official Windows `.7z`, while official `.tar.xz` sources use the
system `tar`.

#### Windows RAR support

Windows currently packages standalone `7za.exe`. That runtime intentionally
omits external format handlers, including RAR, so Zinnia rejects Windows RAR
archives for browse, test, conversion, and extraction before any 7-Zip command
is started. Base `tauri.conf.json` omits RAR file associations; macOS/Linux
platform configs re-add them. Windows packages continue to omit RAR
associations and Explorer verbs. RAR remains available on macOS and Linux.

Re-enable Windows RAR only when the release packages a full RAR-capable runtime
(for example `7z.exe` with its matching handler DLL) and native Windows
browse/test/extract coverage verifies that exact packaged layout.

### Translucent Basic window (macOS / Windows)

Basic mode may enable OS-native window glass (`macOSPrivateApi` +
`window-vibrancy`). This is cosmetic only: Power mode and Linux stay opaque,
and effects-off paints a solid background via `set_background_color`. The
webview still runs under the same CSP and command allow-lists; translucency
does not expand filesystem or network reach.

### Flatpak filesystem access

The Flatpak package grants `--filesystem=home`, `--filesystem=xdg-download`,
`--filesystem=/run/media`, `--filesystem=/media`, and `--filesystem=/mnt` because the bundled 7-Zip
sidecar must read/write user-selected archive paths, including common USB and
download locations outside `$HOME`. Document portals alone cannot cover sidecar
I/O today. This expands the sandbox blast radius relative to a portal-only app;
treat untrusted archives with the same caution as on other platforms.

There is intentionally no `--share=network`. Flatpak builds do not use the
in-app GitHub updater (Settings update UI is hidden); refresh via Flathub or a
reinstalled sideload bundle instead.

### Upstream Rust advisory review

`src-tauri/.cargo/audit.toml` contains a deliberately narrow, documented list
of transitive Tauri/wry/GTK3 advisories. CI fails for every advisory outside
that list. Before each stable release, review the ignored list against the
resolved dependency tree and remove an ignore as soon as Tauri provides an
upgrade path. In particular, the GTK `glib` `VariantStrIter` soundness advisory
is not reached by Zinnia's code, but it remains a Linux runtime dependency and
must not be treated as resolved merely because `cargo audit` allows it.

### Same-user filesystem race boundary

Zinnia re-checks extraction ancestors immediately before publishing staged
output. A same-user process can still race the final rename or hard_link after
that check. Fully eliminating that residual race requires platform-specific
no-follow directory handles; it is tracked as architectural security debt.
The current staging, canonical-path, symlink/reparse, and post-extraction
validation checks remain mandatory defense in depth.

On Unix, promote opens use `O_NOFOLLOW` for the final path component. On
Windows, `open_regular_file_nofollow` opens with `FILE_FLAG_OPEN_REPARSE_POINT`
and rejects reparse tags on the opened handle. Archive publish syncs the
source through that nofollow handle, then uses exclusive path `rename` /
`hard_link` (same residual TOCTOU as above). When neither is available, the
fallback exclusive-create copy re-opens the source with nofollow and copies
from that held handle. Residual same-user TOCTOU remains for the rename /
hard_link path-name lookup itself.

### Open-folder allowlist

The main window may only `open_path` directories that a recent successful
compress/extract promoted. Extract-only windows bind their destination folder at
window spawn (derived from the archive path). They may only extract to that
folder (`-o`) and may only `open_path` that same folder after registering it.
This is defense in depth against a compromised webview writing or opening
arbitrary folders.
