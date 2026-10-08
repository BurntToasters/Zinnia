// Stand-in for the gh CLI, used only by the release dry run. The harness puts
// a `gh` wrapper that execs this file first on PATH for child processes, so
// github-cli.cjs and the scripts that shell out to gh talk to the fake server.
// Supports only the calls the release scripts make: `auth status`,
// `auth token`, and `api --method M <endpoint> [--input F|-] [--header H]`.

import fs from "node:fs";
import http from "node:http";

const fail = (message, code = 1) => {
  process.stderr.write(`gh: ${message}\n`);
  process.exitCode = code;
};

const fakeBase = process.env.FAKE_GITHUB_BASE_URL;
if (!fakeBase) {
  fail("FAKE_GITHUB_BASE_URL is not set; refusing to contact GitHub", 99);
  process.exit(99);
}

const args = process.argv.slice(2);

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write("Logged in to github.com (release dry run fake)\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "token") {
  process.stdout.write("dry-run-fake-token-not-a-credential\n");
  process.exit(0);
}
if (args[0] !== "api") {
  fail(`unsupported fake gh command: ${args.join(" ")}`, 2);
  process.exit(2);
}

let method = "GET";
let endpoint = null;
let inputPath = null;
const headers = { Accept: "application/vnd.github+json" };
for (let i = 1; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--method") {
    method = args[++i];
  } else if (arg === "--input") {
    inputPath = args[++i];
  } else if (arg === "--header") {
    const header = args[++i];
    const separator = header.indexOf(":");
    headers[header.slice(0, separator).trim()] = header
      .slice(separator + 1)
      .trim();
  } else if (arg.startsWith("--")) {
    fail(`unsupported fake gh flag: ${arg}`, 2);
    process.exit(2);
  } else {
    endpoint = arg;
  }
}
if (!endpoint) {
  fail("missing api endpoint", 2);
  process.exit(2);
}

let requestPath;
if (endpoint.startsWith("https://")) {
  const url = new URL(endpoint);
  if (
    url.hostname !== "api.github.com" &&
    url.hostname !== "uploads.github.com"
  ) {
    fail(`refusing non-GitHub host ${url.hostname}`, 99);
    process.exit(99);
  }
  requestPath = url.pathname + url.search;
} else {
  requestPath = endpoint;
}

let body;
if (inputPath === "-") {
  body = fs.readFileSync(0);
} else if (inputPath) {
  body = fs.readFileSync(inputPath);
}
if (body !== undefined) {
  // gh sends JSON request bodies as application/json unless told otherwise.
  if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json; charset=utf-8";
  }
  headers["Content-Length"] = String(body.length);
}

const request = http.request(
  new URL(requestPath, fakeBase),
  { method, headers },
  (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const status = response.statusCode ?? 0;
      if (status >= 400) {
        let message = buffer.toString("utf8").trim();
        try {
          message = JSON.parse(message).message ?? message;
        } catch {
          // Non-JSON error bodies are reported verbatim, as gh does.
        }
        fail(`${message} (HTTP ${status})`, 1);
        return;
      }
      process.stdout.write(buffer, () => process.exit(0));
    });
  },
);
request.on("error", (error) => {
  fail(`request failed: ${error.message}`, 1);
});
if (body !== undefined) request.write(body);
request.end();
