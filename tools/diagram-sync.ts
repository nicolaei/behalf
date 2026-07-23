// Dev tooling — checks that a `​```mermaid source=file#exportName` block in a
// doc is byte-identical to graphToMermaid(the real Graph that binding names).
// A diagram can drift the moment someone edits the graph and forgets to
// regenerate the picture; this is what catches that, the same guarantee
// docs/style-guide.md's code-region sync gives a code snippet.
//
// Lives under tools/ for the same reason graph-to-mermaid.ts does: this is
// repo-internal verification, not part of the published package.

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Graph } from "../src/flow/graph.js";
import { graphToMermaid } from "./graph-to-mermaid.js";

/** One `​```mermaid source=...#...` block found in a doc. */
export interface MermaidSourceBlock {
  source: string; // repo-root-relative path, e.g. "docs/examples/wiring-a-graph/audit.ts"
  exportName: string; // the exported Graph binding's name, e.g. "audit"
  content: string; // the block's body, trimmed of its trailing newline
}

// A leading zero-width space (docs/style-guide.md's own escape convention for
// showing this syntax without triggering it, e.g. in a worked illustration)
// excludes a match — real usage never has one.
const BLOCK_PATTERN = /(?<!\u200b)```mermaid source=(\S+)#(\w+)\n([\s\S]*?)```/g;

/** Finds every sourced mermaid block in `markdown` — a plain mermaid block with no `source=` is left alone. */
export function extractMermaidSourceBlocks(markdown: string): MermaidSourceBlock[] {
  const blocks: MermaidSourceBlock[] = [];
  for (const match of markdown.matchAll(BLOCK_PATTERN)) {
    const [, source, exportName, body] = match;
    if (!source || !exportName || body === undefined) continue;
    blocks.push({ source, exportName, content: body.replace(/\n$/, "") });
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
