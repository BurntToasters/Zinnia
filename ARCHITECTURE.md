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

| Module              | Responsibility                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `validation.rs`     | Allow-list validation of 7z args: the security boundary                                                     |
| `process/`          | Process lifecycle: journal/recovery/staging/commit, `run_7z`/`probe_7z`/`cancel_7z`, 7z version attestation |
| `progress.rs`       | Parse 7z stdout into structured `{percent, filesDone, currentFile}`                                         |
| `archive_detect.rs` | Magic-byte / TAR detection, extension-vs-header validation                                                  |
| `settings_store.rs` | Atomic settings load/save (preserves reserved `_` keys)                                                     |
| `logging.rs`        | Rolling local diagnostics log                                                                               |
| `launch/`           | CLI/file-association routing, extract windows, pending-path queues, quick-extract warm-idle / tray          |
| `platform/`         | Platform/OS-integration queries, defaults commands, xdg-mime / macOS UTI                                    |
| `output.rs`         | Byte-bounded, UTF-8-safe output buffering                                                                   |
| `window_fx.rs`      | Basic-mode native glass (macOS vibrancy, Windows Mica/Acrylic); Linux stays opaque                          |
| `path_safety.rs`    | Symlink / reparse rejection; Unix `O_NOFOLLOW` opens for promote                                            |

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

### Module layout (target)

| Path                   | Responsibility                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `archive/`             | 7z arg building, ops (`runAction` / batch extract), browse/selective UI, command preview |
| `basic/`               | Basic workspace UI, Basic↔Power sync, recent archives, progress chrome                   |
| `ui/`                  | Shared Power/Basic chrome: hooks, logging, workspace mode, status/progress, inputs       |
| `main.ts`              | Thin entry; boot orchestration lives in `app-init.ts` / `power-events.ts`                |
| `power-helpers.ts`     | Shared Power helpers (password toggles, editable-target, reset-for-first-run)            |
| `power-shortcuts.ts`   | Keyboard shortcuts modal                                                                 |
| `power-logs.ts`        | Diagnostics log export / open / clear                                                    |
| `selective-extract.ts` | Pure tree/selection model for the picker                                                 |
| `extract-window.ts`    | Dedicated extract progress window                                                        |
| `os-integration.ts`    | Settings → OS Integration tab                                                            |

### Backend layout (target)

| Path        | Responsibility                                                         |
| ----------- | ---------------------------------------------------------------------- |
| `process/`  | Journal, recovery, staging, commit/promote, `run_7z` / cancel / probe  |
| `platform/` | OS integration status, defaults commands, xdg-mime / macOS UTI helpers |
| `launch/`   | Open-path routing, extract window lifecycle, pending paths             |

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

Three lists must stay intentionally aligned (with platform filters):

| Layer        | File                                                     | Notes                                                                                        |
| ------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Frontend UI  | `src/utils.ts` `ARCHIVE_EXTENSIONS`                      | Includes `.rar`; Windows pickers filter it and Rust routes it through the full 7-Zip sidecar |
| Open routing | `src-tauri/src/launch/open_routing.rs`                   | Includes `.rar` on Windows because packaged `7z.exe` ships with matching `7z.dll`            |
| Win11 shell  | `src-tauri/windows/shell/dllmain.cpp` `LooksLikeArchive` | Includes Windows `.rar` plus `*.7z.001` / split-volume siblings (aligned with open routing)  |

When adding a format, update all three (and file associations / NSIS verbs as needed).

### Remaining size hotspots

Prefer peeling before growing these further: `src/styles/main-mid.css`,
`src/power-events.ts` (`wireEvents`), `src-tauri/src/process/commands.rs`.
Critical coverage gates in `scripts/test-all.js` cover `archive/`, `basic/`,
`power-helpers.ts`, `power-shortcuts.ts`, and other high-risk modules.
