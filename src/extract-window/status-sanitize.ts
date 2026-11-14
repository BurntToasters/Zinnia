const STATUS_NAME_MAX_CHARACTERS = 200;
const FILENAME_START = /^[\p{L}\p{N}._~(\[{]/u;

function userPerceivedCharacters(text: string): string[] {
  if (typeof Intl.Segmenter !== "function") return Array.from(text);
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    (part) => part.segment,
  );
}

/** Strip noisy progress junk so status never flashes missing-glyph boxes. */
export function sanitizeStatusFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001F\u007F-\u009F\uFEFF\uFFFD]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064]/g, "")
    .trim();
  if (!cleaned) return "";
  const withoutProgressJunk = cleaned
    .replace(/^[\s\u2500-\u259F]+(?:-\s*)?/u, "")
    .trim();
  // Start at the first filename-like character. Include `(` / `[` / `{` so
  // names like `(report).txt` keep their parentheses, while still dropping
  // leading `***` / similar symbol runs from 7-Zip progress lines.
  const characters = userPerceivedCharacters(withoutProgressJunk);
  const start = characters.findIndex((character) =>
    FILENAME_START.test(character),
  );
  if (start < 0) return "";
  return characters.slice(start, start + STATUS_NAME_MAX_CHARACTERS).join("");
}
