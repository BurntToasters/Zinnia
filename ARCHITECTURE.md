# Architecture

Zinnia is a [Tauri 2](https://tauri.app) app: a vanilla TypeScript + HTML + CSS
frontend driving a Rust backend that shells out to a bundled 7-Zip sidecar.

```
frontend (src/, TS)  ──invoke()──▶  Rust commands (src-tauri/src/)  ──sidecar──▶  7z
        ▲                                   │
        └────────── events ────────────────┘   (7z-progress, 7z-progress-structured, …)
```

## Backend (`src-tauri/src/`)

`main.rs` is glue only (state registration, builder, command registry). Logic is
split into focused modules:

| Module                    | Responsibility                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `validation.rs`           | Allow-list validation of 7z args (`validation/{switches,members,zip_policy}.rs`): the security boundary       |
| `process/`                | Process lifecycle: journal/recovery/staging/commit, `run_7z`/`probe_7z`/`cancel_7z`, 7z version attestation   |
| `progress.rs`             | Parse 7z stdout into structured `{percent, filesDone, currentFile}`                                           |
| `archive_detect.rs`       | Magic-byte / TAR detection, extension-vs-header validation                                                    |
| `settings_store.rs`       | Atomic settings load/save (carries `_setupWizardVersion` across saves; other legacy `_` keys dropped)         |
| `logging.rs`              | Rolling local diagnostics log                                                                                 |
| `launch/`                 | CLI/file-association routing, extract windows, pending-path queues, quick-extract warm-idle / tray            |
| `platform/`               | Platform/OS-integration queries, defaults commands, xdg-mime / macOS UTI                                      |
| `output.rs`               | Byte-bounded, UTF-8-safe output buffering                                                                     |
| `window_fx.rs`            | Basic-mode native glass (macOS vibrancy, Windows Mica/Acrylic); Linux stays opaque                            |
| `path_safety.rs`          | Symlink / reparse rejection; Unix `O_NOFOLLOW` opens for promote                                              |
| `fs_secure.rs`            | Private stage dirs, nofollow opens, durable sync; platform helpers in `fs_secure/{unix,windows}.rs`           |
| `tempdir.rs`              | Managed temp directories under one app-owned base; stale-dir sweeps; removal refused outside that base        |
| `app_menu.rs`             | Native macOS menu bar; queues menu actions until the main window can receive them                             |
| `macos_services.rs`       | macOS Finder Services provider (Extract / Compress with Zinnia); reads paths from the pasteboard (macOS only) |
| `finder_sync_requests.rs` | macOS: drains requests the sandboxed Finder Sync extension writes to the App Group container (macOS only)     |

`run_7z` validates args, owns one sidecar operation globally, emits throttled
raw (`7z-progress`) plus structured (`7z-progress-structured`) progress events,
and keeps the operation locked until termination is confirmed. Extraction runs
in a contained staging directory and promotes only validated, successful output.
Create and update operations write to a sibling staging basename and atomically
promote the completed archive (including every split volume), so a failed or
cancelled operation never edits the destination archive in place.

Cancellation is a lifecycle state, not just a kill signal: the operation slot
remains busy until the child has exited and staging has been promoted or rolled
back. The extract-only window asks the backend to cancel and waits for that
cleanup before it can be destroyed.

### Window glass and Basic chrome

- Main window is configured with `transparent: true` and `macOSPrivateApi` so
  Basic can use OS vibrancy. `syncWorkspaceWindowFx` (frontend) +
  `set_workspace_window_fx` (Rust) enable glass only in Basic when
  `basicWindowEffects` is on and the platform supports it.
- Power mode, Linux, and effects-off paint an opaque CSS shell
  (`data-window-fx="opaque"`) and clear native effects so the desktop does not
  bleed through.
- Basic folds Basic/Power, Support, and Settings into the custom titlebar;
  Power keeps its separate header row.

### Quick-extract warm idle

After a quick-extract window closes, optional warm-idle keeps the process
resident (tray + idle timer; macOS Dock accessory policy) so the next file open
is faster. Generation counters and main-thread re-checks prevent idle quit from
racing a newly opened extract window.

## Frontend (`src/`)

No framework. State is a single mutable object in `state.ts`; modules
communicate via direct calls and a few custom DOM events.

### Module layout

| Path                   | Responsibility                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `archive/`             | 7z arg building, ops, browse UI; selective extract in `selective-run.ts`, `selective-tree-ui.ts`, `browse-selective-helpers.ts` |
| `basic/`               | Basic workspace UI, Basic↔Power sync, recent archives, progress chrome                                                          |
| `ui/`                  | Shared Power/Basic chrome: hooks, logging, workspace mode, status/progress, inputs                                              |
| `power-events/`        | Main-window DOM wiring split by concern (`session`, `settings`, `presets`, …); `power-events.ts` re-exports `wireEvents`        |
| `extract-window/`      | Extract progress window logic; `extract-window.ts` is the thin entry                                                            |
| `main.ts`              | Thin entry; boot orchestration lives in `app-init.ts`                                                                           |
| `power-helpers.ts`     | Shared Power helpers (password toggles, editable-target, reset-for-first-run)                                                   |
| `power-shortcuts.ts`   | Keyboard shortcuts modal                                                                                                        |
| `power-logs.ts`        | Diagnostics log export / open / clear                                                                                           |
| `selective-extract.ts` | Pure tree/selection model for the picker                                                                                        |
| `os-integration.ts`    | Settings → OS Integration tab                                                                                                   |
| `styles/`              | `main-mid.css` and `basic-chrome.css` are `@import` aggregators over split part files                                           |

### Backend layout

| Path        | Responsibility                                                         |
| ----------- | ---------------------------------------------------------------------- |
| `process/`  | Journal, recovery, staging, commit/promote, `run_7z` / cancel / probe  |
| `platform/` | OS integration status, defaults commands, xdg-mime / macOS UTI helpers |
| `launch/`   | Open-path routing, extract window lifecycle, pending paths             |

Within `process/`, large modules are split at stable seams (behavior unchanged):

| Root file / dir       | Submodules                                               |
| --------------------- | -------------------------------------------------------- |
| `commands.rs`         | `commands/{argv,run,spawn}.rs`                           |
| `commit/mod.rs`       | `{publish,archive_promote,staged_tree,extract_merge}.rs` |
| `journal.rs`          | `journal/{identity,cleanup_journal,pending}.rs`          |
| `archive_snapshot.rs` | `archive_snapshot/{copy,identity,motw,volumes}.rs`       |
| `staging.rs`          | `staging/{slt,plan}.rs`                                  |

Compress input preflight (`compress_preflight.rs`) runs inside the backend; there is no
`probe_compress_inputs` IPC command.

Public Tauri command paths stay `process::run_7z`, `platform::…`, `launch::…` via
re-exports from each crate module root.

- **Two workspaces**: Basic (guided, `basic/`) and Power (3-panel, `ui/`),
  toggled and persisted in settings.
- **Two windows**: the main window (`index.html` → `main.ts`) and a dedicated
  extract progress window (`extract.html` → `extract-window.ts`).
- `archive/` builds 7z arg lists and runs operations; `selective-extract.ts`
  holds the pure tree/selection model for the picker.
- `error-hints.ts` maps 7z failures to recovery hints; `toast.ts` shows
  non-blocking success/info notifications; blocking dialogs are reserved for
  errors needing acknowledgment.
- `settings-model.ts` validates persisted settings (including custom presets).

## Testing

- Frontend: Vitest + jsdom. Shared DOM fixture and Tauri mocks in
  `src/tests/setup-dom.ts`.
- Backend: `cargo test`; unit tests live beside each module.
- Sidecar integration: `src-tauri/tests/sidecar_roundtrip.rs` exercises create,
  list, test, extract, and encrypted-archive failure against bundled 7-Zip.
- CI runs tests and checks on Linux, Windows, and macOS; Clippy and dependency
  audits run as separate security gates. CI also validates updater fixtures and
  optionally fetches published `latest-*.json` manifests (read-only). Release
  binaries are built only by the intentionally destructive platform release
  scripts on isolated build VMs; never by CI.

### Archive extension allowlists

Supported formats are declared once in `archive-formats.json` at the repo root.
Each format lists its extensions, MIME type, magic-byte family, and which
layers include it on which platform. About 30 copies of these lists live in
TypeScript, Rust, C++ (Win11 shell), Swift (Finder Sync), NSIS, the Tauri
configs, and the Linux desktop/metainfo files, each with a different meaning
(recognize, route, strip a folder suffix, create, register an OS association).
`npm run check:archive-formats` (part of `npm run lint`) parses every copy and
fails on any drift from the manifest. Intentional differences between layers
are recorded in the manifest's `asymmetries` array.

`.rar` is recognized and routed on every platform: the bundled `7zz` (macOS,
Linux) and `7z.exe` + `7z.dll` (Windows) both extract RAR. Zinnia never creates
RAR archives.

Base `src-tauri/tauri.conf.json` `bundle.fileAssociations` lists the same ten
extensions as `tauri.windows.conf.json`, `tauri.macos.conf.json`, and
`tauri.linux.conf.json`, including `.rar`.

When adding a format, add it to `archive-formats.json` first, then run the
checker and update each copy it names.

### Removed or fail-closed legacy surfaces

- Settings save no longer writes or restores a `json.bak` sidecar; atomic rename
  replaces the file in place.
- Cleanup journals whose `format_version` is missing or below 1 are refused
  fail-closed (the on-disk journal is preserved). The app shows a recovery
  banner; finishing recovery on 0.6.2 or acknowledging the banner clears the
  marker.
- Format-version 1 cleanup journals must carry explicit `archive_phase`,
  `extract_phase`, and (for extractions) `extract_stage_placement`. Recovery
  refuses journals that omit those fields instead of inferring legacy heuristics.
- Child-process termination waits (7-Zip exit, pipe drain, password stdin
  transport) run on blocking pool threads via `spawn_blocking`, not on the async
  runtime worker that serves Tauri commands.
- The pending-stage registry (`pending-stages.json`) only accepts
  identity-bearing records; legacy plain path strings are ignored.

Critical coverage gates in `scripts/test-all.js` cover `archive/`, `basic/`,
`power-helpers.ts`, `power-shortcuts.ts`, and other high-risk modules.
