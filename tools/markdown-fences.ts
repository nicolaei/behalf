// Dev tooling — finds top-level fenced code blocks in a markdown string,
// shared by code-sync.ts and diagram-sync.ts.
//
// "Top-level" matches real CommonMark semantics: a fenced code block's
// content is raw text, never re-parsed, so a line that *looks* like a fence
// inside another fence's content is not a real fence at all. The only way
// to show a literal fence as text is to wrap it in an outer fence with
// *more* backticks than anything inside (the standard "fence inside a
// fence" technique) — so a scanner that only ever looks for the next fence
// once the current one has closed already gets this for free: an
// illustrative example nested inside a four-backtick `markdown` wrapper is
// content of that one outer block, never surfaced as a fence of its own.
// No escape character needed.

/** One top-level fenced code block. */
export interface Fence {
  fenceLength: number; // how many backticks opened it
  lang: string; // the word straight after the backticks, e.g. "ts", "mermaid"
  info: string; // whatever follows the language on the opening line, e.g. `source=file.ts#setup`
  content: string; // the block's body, trimmed of its trailing newline
}

const OPEN_PATTERN = /^(`{3,})(\S*)(?:\s+(.*))?\s*$/;
const CLOSE_PATTERN = /^(`{3,})\s*$/;

/** Finds every top-level fenced code block in `markdown`. A fence nested inside another fence's content (an illustrative example, not real usage) is never surfaced — only the outer one is. */
export function findTopLevelFences(markdown: string): Fence[] {
  const lines = markdown.split("\n");
  const fences: Fence[] = [];
  let open: { fenceLength: number; lang: string; info: string; contentStart: number } | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;

    if (open) {
      const closeMatch = CLOSE_PATTERN.exec(line);
      if (closeMatch?.[1] && closeMatch[1].length >= open.fenceLength) {
        fences.push({
          fenceLength: open.fenceLength,
          lang: open.lang,
          info: open.info,
          content: lines.slice(open.contentStart, i).join("\n"),
        });
        open = undefined;
      }
      continue; // any other line while inside a fence is opaque content, never a fence marker
    }

    const openMatch = OPEN_PATTERN.exec(line);
    if (openMatch?.[1]) {
      open = {
        fenceLength: openMatch[1].length,
        lang: openMatch[2] ?? "",
        info: openMatch[3] ?? "",
        contentStart: i + 1,
      };
    }
  }

  return fences;
}
