// code-sync — extracts fenced `lang source=file` and `lang source=file#region`
// blocks from a doc and checks each is byte-identical to the real file (or the
// named region within it). A code snippet can't silently drift from the file
// it claims to show; a mismatch is what "properly tested" means for docs.
import { describe, it, expect } from "vitest";
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractSourcedCodeBlocks, checkCodeSync } from "./code-sync.js";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const fixtureSource = "tools/__fixtures__/code-sync/example.ts";

describe("extractSourcedCodeBlocks", () => {
  it("extracts a whole-file reference (no region)", () => {
    const markdown = ["```ts source=a/b.ts", "const x = 1;", "```"].join("\n");

    expect(extractSourcedCodeBlocks(markdown)).toEqual([
      { source: "a/b.ts", region: undefined, content: "const x = 1;" },
    ]);
  });

  it("extracts a region reference", () => {
    const markdown = ["```ts source=a/b.ts#setup", "const x = 1;", "```"].join("\n");

    expect(extractSourcedCodeBlocks(markdown)).toEqual([
      { source: "a/b.ts", region: "setup", content: "const x = 1;" },
    ]);
  });

  it("extracts a hyphenated region reference", () => {
    const markdown = ["```ts source=a/b.ts#wait-point", "const x = 1;", "```"].join("\n");

    expect(extractSourcedCodeBlocks(markdown)).toEqual([
      { source: "a/b.ts", region: "wait-point", content: "const x = 1;" },
    ]);
  });

  it("ignores a mermaid source block (diagram-sync's job, not this one)", () => {
    const markdown = ["```mermaid source=a/b.ts#audit", "flowchart TB", "```"].join("\n");

    expect(extractSourcedCodeBlocks(markdown)).toEqual([]);
  });

  it("ignores a plain code block with no source attribute", () => {
    const markdown = ["```ts", "const x = 1;", "```"].join("\n");

    expect(extractSourcedCodeBlocks(markdown)).toEqual([]);
  });

  it("ignores a fence nested inside an outer, higher-backtick-count fence (an illustrative example, not real usage)", () => {
    const markdown = [
      "````markdown",
      "```ts source=a/b.ts#setup",
      "const x = 1;",
      "```",
      "````",
    ].join("\n");

    expect(extractSourcedCodeBlocks(markdown)).toEqual([]);
  });
});

describe("checkCodeSync", () => {
  it("passes when a whole-file reference matches the real file exactly", async () => {
    const fileContent = await readFile(path.join(repoRoot, fixtureSource), "utf8");
    const markdown = [
      `\`\`\`ts source=${fixtureSource}`,
      fileContent.replace(/\n$/, ""),
      "```",
    ].join("\n");

    const results = await checkCodeSync(markdown, repoRoot);

    expect(results).toEqual([
      {
        source: fixtureSource,
        region: undefined,
        ok: true,
        expected: fileContent.replace(/\n$/, ""),
        actual: fileContent.replace(/\n$/, ""),
      },
    ]);
  });

  it("passes when a region reference matches the named region exactly", async () => {
    const markdown = [
      `\`\`\`ts source=${fixtureSource}#setup`,
      'export const greeting = "hello";',
      "```",
    ].join("\n");

    const results = await checkCodeSync(markdown, repoRoot);

    expect(results).toEqual([
      {
        source: fixtureSource,
        region: "setup",
        ok: true,
        expected: 'export const greeting = "hello";',
        actual: 'export const greeting = "hello";',
      },
    ]);
  });

  it("fails when the shown region has drifted from the real file", async () => {
    const markdown = [
      `\`\`\`ts source=${fixtureSource}#setup`,
      'export const greeting = "stale";',
      "```",
    ].join("\n");

    const results = await checkCodeSync(markdown, repoRoot);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      ok: false,
      actual: 'export const greeting = "hello";',
    });
  });

  it("fails loudly when the named region does not exist in the file", async () => {
    const markdown = [`\`\`\`ts source=${fixtureSource}#doesNotExist`, "x", "```"].join("\n");

    await expect(checkCodeSync(markdown, repoRoot)).rejects.toThrow(/doesNotExist/);
  });

  it("fails loudly when the source file does not exist", async () => {
    const markdown = ["```ts source=tools/__fixtures__/code-sync/nope.ts", "x", "```"].join("\n");

    await expect(checkCodeSync(markdown, repoRoot)).rejects.toThrow(/nope\.ts/);
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

  it("has no drifted code snippets", async () => {
    const files = [
      ...(await findMarkdownFiles(path.join(repoRoot, "docs"))),
      path.join(repoRoot, "README.md"),
    ];

    const failures: string[] = [];
    for (const file of files) {
      const markdown = await readFile(file, "utf8");
      const results = await checkCodeSync(markdown, repoRoot);
      for (const result of results) {
        if (!result.ok) {
          failures.push(
            `${file}: ${result.source}${result.region ? `#${result.region}` : ""} is out of sync`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
