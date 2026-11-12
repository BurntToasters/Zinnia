# Windows release license subprocess PATH

Observed: `release:licenses` starts Node and npm successfully, but npm's
`licenses:npm` lifecycle command cannot resolve `node`. Starting npm with an
absolute `process.execPath` does not put that executable's directory on PATH for
the lifecycle shell.

Failure cases, recorded before implementation:

- npm can start through its absolute CLI while its nested `node` command fails.
- The Node installation directory contains spaces.
- Windows PATH is spelled `Path`, `PATH`, or appears with both spellings; Node
  selects one case-insensitive environment entry when spawning.
- PATH is absent, or contains system tools but lacks the active Node directory.
- Preparing the child environment mutates the parent's environment or loses
  existing tool directories and unrelated environment variables.
- A failed strict Cargo license step must stop execution before `licenses:7zip`.
- Non-Windows invocation must retain its existing environment and npm behavior.

Regression proof: `node --test scripts/release-licenses.test.mjs`. On Windows,
run the real release license runner against a disposable package with real npm
lifecycle commands, a PATH without Node, and all PATH casing variants. Retain
the fixture, child output and result JSON under
`coverage/windows-release-node-path/`. No release build or publishing is needed.
