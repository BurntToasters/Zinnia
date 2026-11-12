# Backend hardening: failure inventory

Written before the tests and code for three audit findings.

## R. Relaunch helper settle delay (`src-tauri/src/platform/relaunch.rs`)

- The helper exits the wait loop when `kill -0` fails, but LaunchServices may
  still list the exited instance, so `open` activates nothing and no new
  instance starts.
- The 0.5 s settle delay could be dropped or moved above the loop, which would
  make the poll bound and the settle delay independent of each other.
- The delay could be placed after `exec`, which makes it unreachable.
- A timeout must still exit 1 before `open` runs; the delay must not run first
  in a way that masks the timeout path.
- Adding `-n` or interpolating a path would reintroduce the second-instance
  bug or shell injection; the delay change must not touch those.
- Tests that assert the exact sleep text could pass while the sleep sits in the
  wrong place, so ordering must be asserted, not just presence.

## T. Reservation set growth (`src-tauri/src/tempdir.rs`)

- Pruning drops a reservation whose path exists, so a live reservation that was
  published is forgotten; a later reserve could return the same path only if
  the 128-bit random token repeats, which the existence check still guards.
- Pruning keeps a reservation whose path is missing, so entries for abandoned
  reservations still accumulate until the cap is reached.
- The cap clears the whole set, which also drops reservations that are still
  in flight; they stop being tracked but remain protected by random tokens and
  the existence check in `reserve_temp_extract_path_blocking`.
- Stat errors other than NotFound (for example permission denied) must not
  remove an entry on their own, so only a successful stat counts as "exists".
- Pruning runs while the reservation mutex is held; a stat that hangs on a
  dead network volume would block the next reservation.
- The helper must not touch the filesystem for entries outside the managed
  base, since it only stats the keys it is given.

## W. Finder Sync wake-up and relaxed idle poll (`src-tauri/src/finder_sync_requests.rs`)

- The directory does not exist until the Finder extension first creates it, so
  registration fails and the monitor must stay on the 2 s ceiling.
- Setup succeeds but the directory is replaced or renamed later; the watch then
  points at a dead vnode and the monitor must not trust it.
- A file created between the last scan and kqueue registration produces no
  event; the watcher must send one initial wake after registration.
- `kevent` returns EINTR on signal delivery; treating it as a failure would
  churn setup every 5 s and drop the watch.
- `kevent` returns EBADF or another error; the thread must mark the watcher
  unhealthy, close both descriptors, and retry, not spin.
- A kqueue or directory descriptor leaks on each retry if a failure path skips
  close; every failure path must close what it opened.
- The healthy flag is set before registration finishes, so the monitor would
  relax to 30 s with no live watch.
- With `tokio` lacking `sync` and `macros`, `Notify` and `select!` do not
  compile. The monitor therefore runs on a dedicated `std::thread` and blocks in
  `recv_timeout(poll)`, so an idle monitor makes no periodic wakeups. Polling in
  short slices instead would wake about 10 times a second and cost more than the
  old 2 s poll.
- `recv_timeout` returns `Disconnected` immediately once the watcher thread is
  gone. Treating that as a timeout would spin at 100% CPU; it must mark the
  watch unhealthy and sleep the poll interval (capped at 2 s) before retrying.
- A `Disconnected` monitor must not report healthy, or it would keep the 30 s
  ceiling with no wake source.
- A failed monitor thread spawn must not leave the watcher running with nobody
  to receive wakes, so the monitor starts before the watcher.
- A wake that arrives while the monitor is between `has_pending_requests` and
  its next wait must not be lost; the channel buffers it.
- A burst of writes must not grow the channel without bound; the monitor drains
  it after each wake.
- The 30 s ceiling must apply only while healthy; a false healthy flag would
  leave requests waiting up to 30 s.
- Existing drain behavior (`DRAIN_SCHEDULED`, `run_on_main_thread`) must not
  change, so a double drain or a missed drain are both regressions.
- The kqueue wait in tests uses a bounded timeout, so a missing event fails the
  test instead of hanging it.
