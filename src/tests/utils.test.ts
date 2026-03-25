import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  parseThreads,
  formatSize,
  splitArgs,
  redactSensitiveText,
  safeHref,
  isArchiveFile,
} from "../utils";

describe("splitArgs", () => {
  it("splits quoted and unquoted arguments", () => {
    expect(splitArgs(`-mx=9 -w "C:/My Folder" 'file one.txt'`)).toEqual([
      "-mx=9",
      "-w",
      "C:/My Folder",
      "file one.txt",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(splitArgs("")).toEqual([]);
  });

  it("handles single argument", () => {
    expect(splitArgs("hello")).toEqual(["hello"]);
  });
});

describe("redactSensitiveText", () => {
  it("redacts -p password args", () => {
    expect(redactSensitiveText("run -pmySecret")).toContain("-p***");
  });

  it("redacts key=value passwords", () => {
    expect(redactSensitiveText("password=abc")).toContain("password=***");
  });

  it("redacts GitHub PATs", () => {
    expect(redactSensitiveText("ghp_1234567890123456789012345")).not.toContain(
      "ghp_",
    );
  });

  it("redacts Bearer tokens", () => {
    expect(redactSensitiveText("Authorization: Bearer abc.def.ghi")).toContain(
      "Bearer ***",
    );
  });

  it("redacts JWTs", () => {
    expect(
      redactSensitiveText(
        "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.sgntrData",
      ),
    ).not.toContain("eyJ");
  });

  it("redacts OpenAI-style keys", () => {
    expect(
      redactSensitiveText("OPENAI_KEY=sk-1234567890abcdefghijklmnopqr"),
    ).not.toContain("sk-123456");
  });
});

describe("isArchiveFile", () => {
  it("recognises known archive extensions", () => {
    expect(isArchiveFile("C:/tmp/file.7z")).toBe(true);
    expect(isArchiveFile("C:/tmp/file.tar.gz")).toBe(true);
    expect(isArchiveFile("/home/user/file.zip")).toBe(true);
    expect(isArchiveFile("file.rar")).toBe(true);
    expect(isArchiveFile("file.xz")).toBe(true);
    expect(isArchiveFile("file.bz2")).toBe(true);
  });

  it("rejects non-archive files", () => {
    expect(isArchiveFile("C:/tmp/file.txt")).toBe(false);
    expect(isArchiveFile("file.pdf")).toBe(false);
    expect(isArchiveFile("file")).toBe(false);
  });
});

describe("escapeHtml", () => {
  it("escapes special HTML characters", () => {
    expect(escapeHtml('<script>"test"</script>')).toBe(
      "&lt;script&gt;&quot;test&quot;&lt;/script&gt;",
    );
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("parseThreads", () => {
  it("parses valid thread counts", () => {
    expect(parseThreads("4", 2)).toBe(4);
  });

  it("returns fallback for NaN", () => {
    expect(parseThreads("abc", 2)).toBe(2);
    expect(parseThreads("", 2)).toBe(2);
  });

  it("clamps to minimum 1", () => {
    expect(parseThreads("0", 2)).toBe(1);
    expect(parseThreads("-5", 2)).toBe(1);
  });

  it("clamps to maximum 128", () => {
    expect(parseThreads("256", 2)).toBe(128);
    expect(parseThreads("999", 2)).toBe(128);
  });
});

describe("formatSize", () => {
  it("returns dash for zero bytes", () => {
    expect(formatSize(0)).toBe("\u2014");
  });

  it("formats bytes", () => {
    expect(formatSize(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatSize(1048576)).toBe("1.0 MB");
  });

  it("formats gigabytes", () => {
    expect(formatSize(1073741824)).toBe("1.0 GB");
  });
});

describe("safeHref", () => {
  it("allows http/https URLs", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("http://example.com")).toBe("http://example.com");
  });

  it("blocks non-http schemes", () => {
    expect(safeHref("javascript:alert(1)")).toBe("#");
    expect(safeHref("data:text/html,test")).toBe("#");
    expect(safeHref("file:///etc/passwd")).toBe("#");
  });

  it("blocks empty strings", () => {
    expect(safeHref("")).toBe("#");
  });
});
