// Dev tooling — checks that a `​```lang source=file` or `​```lang source=file#region`
// block in a doc is byte-identical to the real file (or the named region
// within it). A code snippet can drift from the file it claims to show the
// moment someone edits the file and forgets the doc; this is what catches
// that. Parallel to diagram-sync.ts, which does the same job for a
// `​```mermaid source=file#exportName` block — deliberately not handled
// here, since a mermaid block names an exported binding to import and
// render, not a text region to extract.

import path from "node:path";
import { readFile } from "node:fs/promises";

/** One `​```lang source=...` (or `...#region`) block found in a doc. */
export interface CodeSourceBlock {
  source: string; // repo-root-relative path, e.g. "docs/examples/hello-world/basic.ts"
  region: string | undefined; // absent = the whole file
  content: string; // the block's body, trimmed of its trailing newline
}

// Excludes `mermaid` (diagram-sync's job) and a leading zero-width space
// (docs/style-guide.md's own escape convention for showing this syntax
// without triggering it, e.g. in a worked illustration).
const BLOCK_PATTERN = /(?<!\u200b)```(?!mermaid)\w+ source=(\S+?)(?:#(\w+))?\n([\s\S]*?)```/g;

/** Finds every sourced code block in `markdown` — a plain code block with no `source=`, and any `mermaid` block, are left alone. */
export function extractSourcedCodeBlocks(markdown: string): CodeSourceBlock[] {
  const blocks: CodeSourceBlock[] = [];
  for (const match of markdown.matchAll(BLOCK_PATTERN)) {
    const [, source, region, body] = match;
    if (!source || body === undefined) continue;
    blocks.push({ source, region, content: body.replace(/\n$/, "") });
  }
  return blocks;
}

/** The result of comparing one sourced block against the real file (or region) it names. */
export interface CodeSyncResult {
  source: string;
  region: string | undefined;
  ok: boolean;
  expected: string; // what the doc currently shows
  actual: string; // what the real file (or region) contains right now
}

/** Extracts the named `#region`/`#endregion` slice from `fileContent`, exclusive of the marker lines. Throws if the region isn't found. */
function extractRegion(fileContent: string, region: string, source: string): string {
  const lines = fileContent.split("\n");
  const startIndex = lines.findIndex((line) => line.includes(`#region ${region}`));
  const endIndex = lines.findIndex((line) => line.includes(`#endregion ${region}`));
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`${source} has no #region/#endregion pair named "${region}"`);
  }
  return lines
    .slice(startIndex + 1, endIndex)
    .join("\n")
    .replace(/\n$/, "");
}

/** Checks every sourced code block in `markdown` against the real file each one names. `repoRoot` resolves `source`. */
export async function checkCodeSync(markdown: string, repoRoot: string): Promise<CodeSyncResult[]> {
  const results: CodeSyncResult[] = [];
  for (const block of extractSourcedCodeBlocks(markdown)) {
    const absolutePath = path.join(repoRoot, block.source);
    let fileContent: string;
    try {
      fileContent = await readFile(absolutePath, "utf8");
    } catch {
      throw new Error(`${block.source} does not exist (referenced by a code source= block)`);
    }
    const actual = block.region
      ? extractRegion(fileContent, block.region, block.source)
      : fileContent.replace(/\n$/, "");
    results.push({
      source: block.source,
      region: block.region,
      ok: actual === block.content,
      expected: block.content,
      actual,
    });
  }
  return results;
}
