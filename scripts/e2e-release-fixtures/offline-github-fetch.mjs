// Node preload (loaded with --import) for release dry-run child processes.
// Scripts such as verify-release-draft.js call fetch("https://api.github.com/...")
// directly, with no base-URL override. This redirects GitHub API hosts to the
// in-process fake server and refuses every other host, so no child can reach
// the real network. github.com release downloads (updater feeds and artifacts)
// are served by the fake under /repos/<owner>/<repo>/releases/...
// are served by the fake under /repos/<owner>/<repo>/releases/...

const fakeBase = process.env.FAKE_GITHUB_BASE_URL;
if (fakeBase) {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(raw);
    if (
      url.hostname === "api.github.com" ||
      url.hostname === "uploads.github.com"
    ) {
      return originalFetch(new URL(url.pathname + url.search, fakeBase), init);
    }
    if (url.hostname === "github.com") {
      const download = url.pathname.match(/^\/([^/]+\/[^/]+\/releases\/.+)$/);
      if (download) {
        return originalFetch(
          new URL(`/repos/${download[1]}${url.search}`, fakeBase),
          init,
        );
      }
    }
    return Promise.reject(
      new Error(
        `offline release dry run refused network request to ${url.host}`,
      ),
    );
  };
}

const shims = {
  gh: process.env.FAKE_GH_SHIM,
  cargo: process.env.FAKE_CARGO_SHIM,
};
if (fakeBase && shims.gh && shims.cargo) {
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const childProcess = createRequire(import.meta.url)("node:child_process");
  const redirect = (command, args) => {
    const name =
      typeof command === "string"
        ? command.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase()
        : "";
    const shim = Object.hasOwn(shims, name) ? shims[name] : undefined;
    if (!shim) return null;
    return [process.execPath, [shim, ...(Array.isArray(args) ? args : [])]];
  };
  for (const method of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
    const original = childProcess[method];
    childProcess[method] = function (command, args, ...rest) {
      const target = redirect(command, args);
      if (!target) return original.call(this, command, args, ...rest);
      if (args !== undefined && !Array.isArray(args)) {
        return original.call(this, target[0], target[1], args, ...rest);
      }
      return original.call(this, target[0], target[1], ...rest);
    };
  }
  syncBuiltinESMExports();
}
