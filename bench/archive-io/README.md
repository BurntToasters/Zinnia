# Archive I/O benchmark

`benchmark.mjs` measures deterministic bulk and many-small-file archive I/O. It runs one
warm-up and five measured iterations for bundled 7-Zip, alternating direct/Zinnia order when a
runner is configured. The extraction matrix covers ZIP, 7z, TAR, GZIP, BZIP2, and XZ where
applicable. A representative operation suite labels and measures browse/list, test, extract,
create, replace, update, selective extract, conversion, and aggregate batch.

Run after preparing the host sidecar:

```text
npm run prepare:7z
node bench/archive-io/benchmark.mjs
```

Select workloads or formats:

```text
node bench/archive-io/benchmark.mjs --workloads bulk,small --formats zip,7z,tar
```

The default operation suite runs ZIP/bulk at the smoke scale. Use the release-sized fixture
profile for review runs (it is intentionally not a per-PR wall-clock gate):

```text
node bench/archive-io/benchmark.mjs --scale release --operation-formats zip,7z,tar
```

Use `--operations`, `--operation-formats`, and `--operation-workloads` to narrow or expand the
operation matrix. Smoke is 8 MiB plus 256 small files; release is 64 MiB plus 2048 small files.

The harness accepts either the legacy command adapter or an asynchronous persistent executor.
The executor receives one `ArchiveBenchmarkRequest` for each operation and returns
`{ durationMs, code, stdout? }`. Its `durationMs` must cover product archive work only; the
executor owns one release-built Zinnia process for the full benchmark and may expose `close()`.
The request fields are `operation`, `archive`, `source`, `output`, `target`, `selection`,
`format`, `targetFormat`, `workload`, and optional `password`. The password never enters reports.

Zinnia has no stable headless archive-operation CLI in this repository. The harness therefore
does not pretend that direct 7-Zip is Zinnia. Set `ZINNIA_BENCH_COMMAND` only when an integration
runner exists. The value may be a legacy extract-only argv array, or an operation map keyed by
`browse`, `test`, `extract`, `create`, `replace`, `update`, `selective-extract`, `conversion`,
and `batch`. Template tokens are `{operation}`, `{archive}`, `{input}`, `{output}`, `{target}`,
`{selection}`, `{source}`, `{format}`, `{targetFormat}`, `{workload}`, and `{root}`. The process must return exit
code 0 and leave operation-specific output in the supplied paths; every output is verified.

Example adapter contract:

```text
ZINNIA_BENCH_COMMAND='{"extract":["path/to/headless-zinnia-runner","extract","{archive}","{output}"],"browse":["path/to/headless-zinnia-runner","browse","{input}"]}'
```

The runner also receives `ZINNIA_BENCH_OPERATION`, `ZINNIA_BENCH_ARCHIVE`,
`ZINNIA_BENCH_INPUT`, `ZINNIA_BENCH_OUTPUT`, `ZINNIA_BENCH_TARGET`, `ZINNIA_BENCH_FORMAT`,
`ZINNIA_BENCH_TARGET_FORMAT`, `ZINNIA_BENCH_WORKLOAD`, `ZINNIA_BENCH_SELECTION`, and
`ZINNIA_BENCH_SOURCE` environment variables.

Reports use schema version 3. They contain candidate/base revision metadata, direct and Zinnia
timings, median absolute deviation, normalized Zinnia/direct ratios, separate `targetStatus`
(`met`, `missed`, `not-applicable`) and `trendStatus` (`improved`, `stable`, `regressed`,
`noisy`, `baseline-unavailable`). Bulk target is 1.25x; small-file target is 1.5x. Timing
findings never fail the process. Missing candidate measurements, failed operations, and output
verification failures do fail when `--require-zinnia` is set or a Zinnia adapter is configured.
Use `--baseline-report` to compare in one run, or compare separate reports:

```text
node bench/archive-io/compare.mjs --candidate candidate.json --base baseline.json --output-dir report
```

The comparison command writes JSON and Markdown, and appends to `GITHUB_STEP_SUMMARY` when set.
Use `--allow-missing-candidate` only for direct-only rollout diagnostics. Use `--output-dir` or
`ZINNIA_BENCH_REPORT_DIR` for CI artifact output. Omitted commands remain `n/a`, never fake
 numbers. Pass `--compatibility` (used by the nightly workflow) to measure the tracked RAR
 fixture, generated split volumes, password-bearing fixture, and a generated TAR whose listing
 must contain non-empty `Hard Link =` or `Symbolic Link =` metadata before timing starts. Link
 preservation is host-gated: a host that cannot create or preserve the link is reported as
 `not-available`. Unsupported-filesystem and custom-ACL rows are also always explicit
 `not-available` rows; no substitute timing is invented. All compatibility rows stay outside
 primary target/trend rollups.

`structural-check.mjs` protects performance-sensitive source shape. It rejects update archive
pre-copy, repeated same-phase whole-tree fingerprints, missing publish strategy classification,
and quota monitoring that cannot consume manifest headroom. It is a deterministic source gate,
not a wall-clock benchmark.
