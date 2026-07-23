// Dev tooling — checks that a fenced `mermaid source=file#exportName` block in a
// doc is byte-identical to graphToMermaid(the real Graph that binding names).
// A diagram can drift the moment someone edits the graph and forgets to
// regenerate the picture; this is what catches that, the same guarantee
// docs/style-guide.md's code-region sync gives a code snippet.
//
// Lives under tools/ for the same reason graph-to-mermaid.ts does: this is
// repo-internal verification, not part of the published package.
//
// Only looks at top-level fences (markdown-fences.ts): an illustrative
// example nested inside an outer, higher-backtick-count fence (the standard
// CommonMark way to show a literal fence as text) is real content of that
// outer block, never a fence of its own, so it's naturally invisible here —
// no escape character needed.

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Graph } from "../src/flow/graph.js";
import { graphToMermaid } from "./graph-to-mermaid.js";
import { findTopLevelFences } from "./markdown-fences.js";

/** One fenced `mermaid source=...#...` block found in a doc. */
export interface MermaidSourceBlock {
  source: string; // repo-root-relative path, e.g. "docs/examples/wiring-a-graph/audit.ts"
  exportName: string; // the exported Graph binding's name, e.g. "audit"
  content: string; // the block's body, trimmed of its trailing newline
}

const INFO_PATTERN = /^source=(\S+)#(\w+)$/;

/** Finds every sourced mermaid block in `markdown` — a plain mermaid block with no `source=` is left alone. */
export function extractMermaidSourceBlocks(markdown: string): MermaidSourceBlock[] {
  const blocks: MermaidSourceBlock[] = [];
  for (const fence of findTopLevelFences(markdown)) {
    if (fence.lang !== "mermaid") continue;
    const match = INFO_PATTERN.exec(fence.info);
    if (!match?.[1] || !match[2]) continue;
    blocks.push({ source: match[1], exportName: match[2], content: fence.content });
  }
  return blocks;
}

/** The result of comparing one sourced block against the real graph it names. */
export interface DiagramSyncResult {
  source: string;
  exportName: string;
  ok: boolean;
  expected: string; // what the doc currently shows
  actual: string; // what graphToMermaid(theRealGraph) produces right now
}

/** Checks every sourced mermaid block in `markdown` against the real graph each one names. `repoRoot` resolves `source`. */
export async function checkDiagramSync(
  markdown: string,
  repoRoot: string,
): Promise<DiagramSyncResult[]> {
  const results: DiagramSyncResult[] = [];
  for (const block of extractMermaidSourceBlocks(markdown)) {
    const absolutePath = path.join(repoRoot, block.source);
    const loaded = (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
    const graph = loaded[block.exportName];
    if (graph === undefined) {
      throw new Error(
        `${block.source} has no export named "${block.exportName}" (referenced by a mermaid source= block)`,
      );
    }
    const actual = graphToMermaid(graph as Graph);
    results.push({
      source: block.source,
      exportName: block.exportName,
      ok: actual === block.content,
      expected: block.content,
      actual,
    });
  }
  return results;
}
