/**
 * Capped, append-only log text. Each append adds one Text node and trims the
 * oldest lines by node, so the element is never re-split or re-assigned.
 */
interface LogSegment {
  node: Text;
  lines: number;
}

interface LogTail {
  segments: LogSegment[];
  lineCount: number;
}

const tails = new WeakMap<HTMLElement, LogTail>();

function countLines(text: string): number {
  let count = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    count += 1;
  }
  return count;
}

/**
 * Other code clears or replaces the element (`textContent = ""`, seeds). When
 * the tracked nodes no longer match the children, rebuild tracking from the
 * current text in one pass.
 */
function syncTail(el: HTMLElement): LogTail {
  const tracked = tails.get(el);
  const last = tracked?.segments.at(-1)?.node ?? null;
  const first = tracked?.segments[0]?.node ?? null;
  if (
    tracked?.segments.length === el.childNodes.length &&
    el.firstChild === first &&
    el.lastChild === last
  ) {
    return tracked;
  }

  const text = el.textContent ?? "";
  el.replaceChildren();
  const segments: LogSegment[] = [];
  if (text.length > 0) {
    const node = document.createTextNode(text);
    el.appendChild(node);
    segments.push({ node, lines: countLines(text) });
  }
  const rebuilt: LogTail = {
    segments,
    lineCount: segments.reduce((sum, segment) => sum + segment.lines, 0),
  };
  tails.set(el, rebuilt);
  return rebuilt;
}

function trimOldestLines(tail: LogTail, maxLines: number): void {
  while (tail.lineCount > maxLines && tail.segments.length > 0) {
    const head = tail.segments[0];
    const excess = tail.lineCount - maxLines;
    if (head.lines <= excess) {
      head.node.remove();
      tail.segments.shift();
      tail.lineCount -= head.lines;
      continue;
    }
    // Cut the head segment after its first `excess` lines.
    let cut = 0;
    for (let i = 0; i < excess; i += 1) {
      cut = head.node.data.indexOf("\n", cut) + 1;
    }
    head.node.deleteData(0, cut);
    head.lines -= excess;
    tail.lineCount -= excess;
  }
}

/**
 * Append `text` (newline-terminated lines) and keep only the newest
 * `maxLines` lines. Callers keep their own scroll handling.
 */
export function appendCappedLogText(
  el: HTMLElement,
  text: string,
  maxLines: number,
): void {
  const tail = syncTail(el);
  const node = document.createTextNode(text);
  el.appendChild(node);
  const lines = countLines(text);
  tail.segments.push({ node, lines });
  tail.lineCount += lines;
  trimOldestLines(tail, maxLines);
}
