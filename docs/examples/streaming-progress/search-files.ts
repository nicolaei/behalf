// The Learn "Streaming progress" page's example: a search_files-style tool
// that reports partial progress through its own stream while it works, plus
// a small standalone tool that demonstrates the delta/commit/abort lifecycle
// directly. Driven with a real filesystem walk (a temp directory, not a
// human-timed search) and a scripted "abort" input in search-files.test.ts,
// so both paths are actually exercised by a test.

import { tool, provide } from "@behalf-js/core";
import type { Binding } from "@behalf-js/core";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const searchFiles = tool<
  { path: string; query: string },
  { matches: { file: string; line: number }[] }
>("search_files", "Recursively search files under a directory for a substring match.");

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, race, etc.) — skip it
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await walk(root);
  return files;
}

// #region slow-tool
export const searchFilesBinding: Binding = provide(searchFiles, async (input, context) => {
  // #region open-stream
  const stream = context.openStream("output");
  // #endregion open-stream
  const files = await collectFiles(input.path);
  const matches: { file: string; line: number }[] = [];
  let scanned = 0;
  for (const file of files) {
    try {
      const content = await readFile(file, "utf-8");
      content.split("\n").forEach((line, index) => {
        if (line.includes(input.query)) matches.push({ file, line: index + 1 });
      });
    } catch {
      // unreadable file (binary, permissions, etc.) — skip it, keep searching
    }
    scanned++;
    stream.delta({
      correlationId: context.correlationId,
      text: `scanned ${scanned}/${files.length} files (${matches.length} hits so far)`,
    });
  }
  stream.commit({ value: { matches } });
  return { matches };
});
// #endregion slow-tool

// #region lifecycle
export const progressDemo = tool<{ succeed: boolean }, { done: boolean }>(
  "progress_demo",
  "Streams one delta, then commits or aborts depending on its input.",
);

export const progressDemoBinding: Binding = provide(progressDemo, (input, context) => {
  const stream = context.openStream("output");
  stream.delta({ correlationId: context.correlationId, text: "partial progress" });
  if (input.succeed) stream.commit({ value: { done: true } });
  else stream.abort();
  return Promise.resolve({ done: input.succeed });
});
// #endregion lifecycle
