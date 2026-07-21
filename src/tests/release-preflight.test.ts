import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  expectedReleaseBranch,
  selectLatestCiRun,
} from "../../scripts/release-preflight.js";

describe("release preflight policy", () => {
  it("wires source and quality gates into every release entry point", () => {
    const root = process.cwd();
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const testRunner = fs.readFileSync(
      path.join(root, "scripts", "test-all.js"),
      "utf8",
    );

    expect(packageJson.scripts["prerelease:prepare"]).toContain(
      "release:preflight",
    );
    expect(packageJson.scripts["release:prepare"]).toContain("test:all");
    expect(testRunner).toContain('"rustfmt"');
    expect(testRunner).toContain('"clippy"');
  });

  it("routes prereleases to beta and stable releases to main", () => {
    expect(expectedReleaseBranch("0.6.0-beta.10")).toBe("beta");
    expect(expectedReleaseBranch("0.6.0-rc.2")).toBe("beta");
    expect(expectedReleaseBranch("0.6.0")).toBe("main");
  });

  it("selects the latest completed push CI for the exact commit", () => {
    const wanted = {
      name: "CI",
      event: "push",
      head_branch: "beta",
      head_sha: "abc123",
      status: "completed",
      conclusion: "success",
      updated_at: "2026-07-21T02:00:00Z",
    };
    const selected = selectLatestCiRun(
      [
        {
          ...wanted,
          conclusion: "failure",
          updated_at: "2026-07-21T01:00:00Z",
        },
        {
          ...wanted,
          event: "pull_request",
          updated_at: "2026-07-21T03:00:00Z",
        },
        wanted,
        { ...wanted, head_sha: "other", updated_at: "2026-07-21T04:00:00Z" },
      ],
      { branch: "beta", sha: "abc123" },
    );

    expect(selected).toBe(wanted);
  });

  it("does not accept CI from another branch or commit", () => {
    expect(
      selectLatestCiRun(
        [
          {
            name: "CI",
            event: "push",
            head_branch: "main",
            head_sha: "other",
            status: "completed",
            conclusion: "success",
          },
        ],
        { branch: "beta", sha: "abc123" },
      ),
    ).toBeUndefined();
  });
});
