// Dev tooling — checks that a fenced `lang source=file` or `lang source=file#region`
// block in a doc is byte-identical to the real file (or the named region
// within it). A code snippet can drift from the file it claims to show the
// moment someone edits the file and forgets the doc; this is what catches
// that. Parallel to diagram-sync.ts, which does the same job for a
// a `mermaid source=file#exportName` block — deliberately not handled
// here, since a mermaid block names an exported binding to import and
// render, not a text region to extract.
//
// Only looks at top-level fences (markdown-fences.ts): an illustrative
// example nested inside an outer, higher-backtick-count fence (the standard
// CommonMark way to show a literal fence as text) is real content of that
// outer block, never a fence of its own, so it's naturally invisible here —
// no escape character needed.

import path from "node:path";
import { readFile } from "node:fs/promises";
import { findTopLevelFences } from "./markdown-fences.js";

/** One fenced `lang source=...` (or `...#region`) block found in a doc. */
export interface CodeSourceBlock {
  source: string; // repo-root-relative path, e.g. "docs/examples/hello-world/basic.ts"
  region: string | undefined; // absent = the whole file
  content: string; // the block's body, trimmed of its trailing newline
}

const INFO_PATTERN = /^source=(\S+?)(?:#([\w-]+))?$/;

/** Finds every sourced code block in `markdown` — a plain code block with no `source=`, and any `mermaid` block (diagram-sync's job), are left alone. */
export function extractSourcedCodeBlocks(markdown: string): CodeSourceBlock[] {
  const blocks: CodeSourceBlock[] = [];
  for (const fence of findTopLevelFences(markdown)) {
    if (fence.lang === "mermaid") continue;
    const match = INFO_PATTERN.exec(fence.info);
    if (!match?.[1]) continue;
    blocks.push({ source: match[1], region: match[2], content: fence.content });
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

const REGION_MARKER_PATTERN = /^\s*\/\/\s*#(?:end)?region\b.*$/;

/** Strips every `#region`/`#endregion` marker line: a reader sees the code a region names, not the doc-tooling's own folding markers (including any nested region's markers a slice happens to contain). */
export function stripRegionMarkers(content: string): string {
  return content
    .split("\n")
    .filter((line) => !REGION_MARKER_PATTERN.test(line))
    .join("\n");
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
    const raw = block.region
      ? extractRegion(fileContent, block.region, block.source)
      : fileContent.replace(/\n$/, "");
    const actual = stripRegionMarkers(raw);
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
