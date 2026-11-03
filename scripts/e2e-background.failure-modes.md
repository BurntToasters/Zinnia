# E2E background mode: failure modes

`scripts/test-e2e.js` sets `ZINNIA_E2E_BACKGROUND=1` for local macOS runs so the
E2E app never takes focus, never comes to the foreground, and its window stays
below other apps. Rust reads the flag through `launch::e2e_background`
(`src-tauri/src/launch/mod.rs`) and gates the window builders, the focus calls,
and the activation-policy switches in `launch/extract_window.rs`,
`launch/debug_console_window.rs`, and `main.rs`.

1. CI runs in background mode. CI must keep the normal foreground behavior,
   because hosted runners have no user to disturb and evidence must match the
   shipped window behavior.
2. A maintainer cannot opt out. `ZINNIA_E2E_FOREGROUND=1` must disable background
   mode even on a local Mac.
3. An explicit `ZINNIA_E2E_BACKGROUND` value is overwritten. A value the caller
   set (`1` or `0`) must win over the default.
4. Windows or Linux runs get the flag. Only macOS implements the mode; Linux
   already has the Xvfb path, and Windows is unchanged.
5. `CI` set to an empty string is not CI. An empty `CI` must not turn off the
   local default.
6. `CI=false` or `CI=0` is not CI. Those values must not turn off the local
   default either.
7. The flag reaches every app launch. It must be set on the runner's own
   environment before the first launch, so the main, extract-window, crash and
   recovery, and scenario specs all inherit it.
8. The Rust side needs both the flag and an E2E session. `e2e_background` requires
   `ZINNIA_E2E=1` and macOS, so a dev or release binary launched by hand with
   `ZINNIA_E2E_BACKGROUND=1` behaves as before. Release builds compile the gate
   out entirely.
9. Extract-window activation switching. `restore_foreground_activation` switches
   the app to `Regular` before every extract, main, and debug-console show. In
   background mode the policy must stay `Accessory`, or the Dock icon appears and
   the app activates. The Reopen and warm-idle paths use the same switch and are
   covered by the same gate.
10. A missed focus call steals focus. `set_focus` in `show_main_window`, the
    extract window open, the debug console open, and the Reopen handler must be
    skipped in background mode. Frontend code has no window `setFocus` calls.
    The launch itself also activates the app. Tao activates in
    `applicationDidFinishLaunching`, which runs before the `setup` hook, so
    `setup` alone cannot stop it. The builder must set
    `activate_ignoring_other_apps(false)` in background mode.
11. A window is created focused or above other windows. Each E2E window builder
    must set `focused(false)` and `always_on_bottom(true)` in background mode.
12. Hidden or occluded windows can pause rendering or timers. The E2E builders
    already disable WebKit background throttling. A spec that still depends on
    focus, such as keyboard input routed to the focused window, must fail and be
    reported. It must not be skipped to make the run green. The maintainer reruns
    it with `ZINNIA_E2E_FOREGROUND=1`.
13. Native dialogs still appear. Native alert and file dialogs that specs open on
    purpose can take focus, and background mode cannot suppress them. This is
    documented, not a bug.
14. The frontmost-app evidence is sampled every 0.5 s. A focus steal shorter
    than one sample is invisible to the sampler. The proof records the sample
    count so a short run cannot pass on zero samples.
15. The release build gets the behavior unchanged. All Rust changes are behind
    the `e2e` Cargo feature, which production builds never enable.
