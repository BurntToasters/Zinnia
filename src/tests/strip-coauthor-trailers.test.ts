import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  coauthorPolicyViolationsInRange,
  isCoauthorEmailLine,
  isDirectExecution,
  isForbiddenCoauthorEmail,
  messageHasCoauthorEmail,
  messageHasCoauthorPolicyViolation,
  parseArgs,
  parseCoauthorEmailLine,
  stripCoauthorTrailers,
  stripCoauthorTrailersFile,
} from "../../scripts/strip-coauthor-trailers.js";

const temporaryDirectories: string[] = [];

function tempFile(contents: string): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "zinnia-coauthor-trailers-"),
  );
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "COMMIT_EDITMSG");
  fs.writeFileSync(filePath, contents);
  return filePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("strip Co-authored-by email trailers", () => {
  it("matches any Co-authored-by line that includes an email", () => {
    expect(
      isCoauthorEmailLine("Co-authored-by: Cursor <cursoragent@cursor.com>"),
    ).toBe(true);
    expect(
      parseCoauthorEmailLine("Co-authored-by: Jane <!jane@example.com>"),
    ).toEqual({ exempt: true, email: "jane@example.com" });
    expect(isCoauthorEmailLine("Co-authored-by: Cursor")).toBe(false);
    expect(isCoauthorEmailLine("Made-with: Cursor")).toBe(false);
    expect(
      isCoauthorEmailLine(
        "Signed-off-by: BurntToasters <61037367+BurntToasters@users.noreply.github.com>",
      ),
    ).toBe(false);
  });

  it("never keeps known agent emails, even with !", () => {
    expect(isForbiddenCoauthorEmail("cursoragent@cursor.com")).toBe(true);
    expect(isForbiddenCoauthorEmail("noreply@anthropic.com")).toBe(true);
    expect(isForbiddenCoauthorEmail("jane@example.com")).toBe(false);
  });

  it("strips emailed co-authors unless they opted in with !", () => {
    const stripped = stripCoauthorTrailers(
      [
        "fix(windows): use stable hardlink identity APIs",
        "",
        "MetadataExt file_index/number_of_links need unstable",
        "windows_by_handle and break Windows CI on stable Rust.",
        "",
        "Co-authored-by: Cursor <cursoragent@cursor.com>",
        "Co-authored-by: Someone <someone@example.com>",
        "Co-authored-by: Jane <!jane@example.com>",
        "Co-authored-by: Cursor <!cursoragent@cursor.com>",
        "Co-authored-by: Note without email",
        "",
      ].join("\n"),
    );
    expect(stripped).toBe(
      [
        "fix(windows): use stable hardlink identity APIs",
        "",
        "MetadataExt file_index/number_of_links need unstable",
        "windows_by_handle and break Windows CI on stable Rust.",
        "",
        "Co-authored-by: Jane <jane@example.com>",
        "Co-authored-by: Note without email",
        "",
      ].join("\n"),
    );
    expect(messageHasCoauthorEmail(stripped)).toBe(true);
    expect(messageHasCoauthorPolicyViolation(stripped)).toBe(false);
  });

  it("rewrites a commit-message file in place", () => {
    const filePath = tempFile(
      "subject\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\nCo-authored-by: Jane <!jane@example.com>\n",
    );
    const result = stripCoauthorTrailersFile(filePath);
    expect(result.changed).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe(
      "subject\n\nCo-authored-by: Jane <jane@example.com>\n",
    );
  });

  it("parses hook and CI argument forms", () => {
    expect(parseArgs(["node", "script.js", "COMMIT_EDITMSG"])).toEqual({
      mode: "in-place",
      file: "COMMIT_EDITMSG",
    });
    expect(
      parseArgs(["node", "script.js", "--check-range", "abc..def"]),
    ).toEqual({
      mode: "check-range",
      range: "abc..def",
    });
  });

  it("reports leftover ! markers and agent emails, not kept human trailers", () => {
    const hits = coauthorPolicyViolationsInRange("base..head", {
      spawn: () =>
        ({
          status: 0,
          stdout: [
            "abc123\nfix\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n==END==",
            "def456\nclean subject\n==END==",
            "ghi789\nkeep\n\nCo-authored-by: Jane <jane@example.com>\n==END==",
            "jkl012\nraw\n\nCo-authored-by: Jane <!jane@example.com>\n==END==",
            "",
          ].join("\n"),
          stderr: "",
          error: undefined,
        }) as ReturnType<typeof import("node:child_process").spawnSync>,
    });
    expect(hits).toEqual(["abc123", "jkl012"]);
  });

  it("detects direct execution without import.meta.main", () => {
    const scriptPath = path.resolve("scripts/strip-coauthor-trailers.js");
    expect(isDirectExecution(pathToFileURL(scriptPath).href, scriptPath)).toBe(
      true,
    );
    expect(
      isDirectExecution(pathToFileURL(scriptPath).href, "/tmp/other.js"),
    ).toBe(false);
  });

  it("wires commit-msg and prepare-commit-msg through the shared stripper", () => {
    const commitMsg = fs.readFileSync(
      path.resolve(".githooks/commit-msg"),
      "utf8",
    );
    const prepare = fs.readFileSync(
      path.resolve(".githooks/prepare-commit-msg"),
      "utf8",
    );
    const shared = fs.readFileSync(
      path.resolve(".githooks/strip-coauthor-trailers.sh"),
      "utf8",
    );
    const workflow = fs.readFileSync(
      path.resolve(".github/workflows/ci.yml"),
      "utf8",
    );
    expect(commitMsg).toContain("strip-coauthor-trailers.sh");
    expect(prepare).toContain("strip-coauthor-trailers.sh");
    expect(shared).toContain("scripts/strip-coauthor-trailers.js");
    expect(
      fs.existsSync(path.resolve("scripts/strip-coauthor-trailers.d.ts")),
    ).toBe(true);
    expect(shared).toContain("cmd.exe //d //c node");
    expect(workflow).toContain("commit-message-policy:");
    expect(workflow).toContain(
      "node scripts/strip-coauthor-trailers.js --check-range",
    );
  });
});
