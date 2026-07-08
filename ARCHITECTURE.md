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

| Module | Responsibility |
| --- | --- |
| `validation.rs` | Allow-list validation of 7z args — the security boundary |
| `process.rs` | Process lifecycle: single-slot state, shared spawn/drain, `run_7z`/`probe_7z`/`cancel_7z` |
| `progress.rs` | Parse 7z stdout into structured `{percent, filesDone, currentFile}` |
| `archive_detect.rs` | Magic-byte / TAR detection, extension-vs-header validation |
| `settings_store.rs` | Atomic settings load/save (preserves reserved `_` keys) |
| `logging.rs` | Rolling local diagnostics log |
| `launch.rs` | CLI/file-association routing, extract windows, pending-path queues |
| `platform.rs` | Platform/OS-integration queries |
| `output.rs` | Byte-bounded, UTF-8-safe output buffering |

`run_7z` validates args, spawns the sidecar via the shared drain helper, emits
raw (`7z-progress`) and structured (`7z-progress-structured`) progress events,
and on cancel deletes the partial output of a *create* (`a`) operation.

## Frontend (`src/`)

No framework. State is a single mutable object in `state.ts`; modules
communicate via direct calls and a few custom DOM events.

- **Two workspaces**: Basic (guided, `basic-ui.ts`) and Power (3-panel,
  `ui.ts`), toggled and persisted in settings.
- **Two windows**: the main window (`index.html` → `main.ts`) and a dedicated
  extract progress window (`extract.html` → `extract-window.ts`).
- `archive.ts` builds 7z arg lists and runs operations; `selective-extract.ts`
  holds the pure tree/selection model for the picker.
- `error-hints.ts` maps 7z failures to recovery hints; `toast.ts` shows
  non-blocking success/info notifications; blocking dialogs are reserved for
  errors needing acknowledgment.
- `settings-model.ts` validates persisted settings (including custom presets).

## Testing

- Frontend: Vitest + jsdom. Shared DOM fixture and Tauri mocks in
  `src/tests/setup-dom.ts`.
- Backend: `cargo test` — unit tests live beside each module.
