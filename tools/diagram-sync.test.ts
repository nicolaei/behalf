// diagram-sync — extracts `​```mermaid source=file#exportName` blocks from a
// doc, imports the real Graph each one names, and checks the embedded
// diagram is byte-identical to graphToMermaid(thatGraph). A diagram can't
// silently drift from the wiring it depicts, the same guarantee the
// code-region sync gives a code snippet.
import { describe, it, expect } from "vitest";
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractMermaidSourceBlocks, checkDiagramSync } from "./diagram-sync.js";
import { graphToMermaid } from "./graph-to-mermaid.js";
import { example } from "./__fixtures__/diagram-sync/example.js";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const fixtureSource = "tools/__fixtures__/diagram-sync/example.ts";

describe("extractMermaidSourceBlocks", () => {
  it("extracts the source path, export name, and content of a sourced block", () => {
    const markdown = ["```mermaid source=a/b.ts#thing", "flowchart TB", "  x", "```"].join("\n");

    expect(extractMermaidSourceBlocks(markdown)).toEqual([
      { source: "a/b.ts", exportName: "thing", content: "flowchart TB\n  x" },
    ]);
  });

  it("ignores a plain mermaid block with no source attribute", () => {
    const markdown = ["```mermaid", "flowchart TB", "```"].join("\n");

    expect(extractMermaidSourceBlocks(markdown)).toEqual([]);
  });

  it("ignores a code block in another language", () => {
    const markdown = ["```ts source=a/b.ts#thing", "const x = 1;", "```"].join("\n");

    expect(extractMermaidSourceBlocks(markdown)).toEqual([]);
  });

  it("extracts every sourced block when a doc has several", () => {
    const markdown = [
      "```mermaid source=a/b.ts#one",
      "flowchart TB",
      "```",
      "",
      "some prose in between",
      "",
      "```mermaid source=a/b.ts#two",
      "flowchart LR",
      "```",
    ].join("\n");

    expect(extractMermaidSourceBlocks(markdown)).toEqual([
      { source: "a/b.ts", exportName: "one", content: "flowchart TB" },
      { source: "a/b.ts", exportName: "two", content: "flowchart LR" },
    ]);
  });

  it("ignores an illustrative block escaped with a leading zero-width space (docs/style-guide.md's convention for showing syntax without triggering it)", () => {
    const markdown = ["\u200b```mermaid source=a/b.ts#thing", "flowchart TB", "\u200b```"].join(
      "\n",
    );

    expect(extractMermaidSourceBlocks(markdown)).toEqual([]);
  });
});

describe("checkDiagramSync", () => {
  it("passes when the embedded diagram matches the real graph it names", async () => {
    const rendered = graphToMermaid(example);
    const markdown = [`\`\`\`mermaid source=${fixtureSource}#example`, rendered, "```"].join("\n");

    const results = await checkDiagramSync(markdown, repoRoot);

    expect(results).toEqual([
      {
        source: fixtureSource,
        exportName: "example",
        ok: true,
        expected: rendered,
        actual: rendered,
      },
    ]);
  });

  it("fails when the embedded diagram has drifted from the real graph", async () => {
    const stale = 'flowchart TB\n  node-1["stale"]';
    const markdown = [`\`\`\`mermaid source=${fixtureSource}#example`, stale, "```"].join("\n");

    const results = await checkDiagramSync(markdown, repoRoot);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, actual: graphToMermaid(example) });
  });

  it("fails loudly when the named export does not exist", async () => {
    const markdown = [
      `\`\`\`mermaid source=${fixtureSource}#doesNotExist`,
      "flowchart TB",
      "```",
    ].join("\n");

    await expect(checkDiagramSync(markdown, repoRoot)).rejects.toThrow(/doesNotExist/);
  });
});

describe("the real docs tree", () => {
  async function findMarkdownFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await findMarkdownFiles(full)));
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
    }
    return files;
  }

  it("has no drifted diagrams (vacuously true until docs use this convention)", async () => {
    const docsDir = path.join(repoRoot, "docs");
    const files = await findMarkdownFiles(docsDir);

    const failures: string[] = [];
    for (const file of files) {
      const markdown = await readFile(file, "utf8");
      const results = await checkDiagramSync(markdown, repoRoot);
      for (const result of results) {
        if (!result.ok)
          failures.push(`${file}: ${result.source}#${result.exportName} is out of sync`);
      }
    }

    expect(failures).toEqual([]);
  });
});
