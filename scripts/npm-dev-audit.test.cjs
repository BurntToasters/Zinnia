"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateAudit } = require("./npm-dev-audit.cjs");

function lockFor(...nodes) {
  return {
    packages: Object.fromEntries(nodes.map((node) => [node, { dev: true }])),
  };
}

test("reviewed WDIO advisory chains pass only when every node is dev-only", () => {
  const report = {
    vulnerabilities: {
      "deepmerge-ts": {
        nodes: ["node_modules/deepmerge-ts"],
        via: [
          {
            name: "deepmerge-ts",
            url: "https://github.com/advisories/GHSA-ggr8-5vv4-36mx",
          },
        ],
      },
      webdriver: {
        nodes: ["node_modules/webdriver"],
        via: ["deepmerge-ts"],
      },
    },
  };
  const result = evaluateAudit(
    report,
    lockFor("node_modules/deepmerge-ts", "node_modules/webdriver"),
    new Date("2026-09-05T00:00:00Z"),
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.reviewed, [["GHSA-GGR8-5VV4-36MX", "deepmerge-ts"]]);
});

test("a reviewed advisory fails if npm can reach a production node", () => {
  const report = {
    vulnerabilities: {
      "extract-zip": {
        nodes: ["node_modules/extract-zip"],
        via: [
          {
            name: "extract-zip",
            url: "https://github.com/advisories/GHSA-jmr9-qjv8-65gv",
          },
        ],
      },
    },
  };
  const lock = { packages: { "node_modules/extract-zip": { dev: false } } };
  const result = evaluateAudit(report, lock, new Date("2026-09-05T00:00:00Z"));
  assert.match(result.errors.join("\n"), /not proven dev-only/);
});

test("new advisories fail closed", () => {
  const report = {
    vulnerabilities: {
      mystery: {
        nodes: ["node_modules/mystery"],
        via: [
          {
            name: "mystery",
            url: "https://github.com/advisories/GHSA-2345-6789-cfgh",
          },
        ],
      },
    },
  };
  const result = evaluateAudit(
    report,
    lockFor("node_modules/mystery"),
    new Date("2026-09-05T00:00:00Z"),
  );
  assert.match(result.errors.join("\n"), /unreviewed advisory/);
});

test("reviewed exceptions expire", () => {
  const report = {
    vulnerabilities: {
      "serialize-javascript": {
        nodes: ["node_modules/serialize-javascript"],
        via: [
          {
            name: "serialize-javascript",
            url: "https://github.com/advisories/GHSA-qj8w-gfj5-8c6v",
          },
        ],
      },
    },
  };
  const result = evaluateAudit(
    report,
    lockFor("node_modules/serialize-javascript"),
    new Date("2026-12-01T00:00:00Z"),
  );
  assert.match(result.errors.join("\n"), /review expired/);
});
