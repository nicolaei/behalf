// M3 — real filesystem tools: read_file, list_directory, get_cwd. Handlers do
// real I/O (node:fs/promises) and resolve relative paths against process.cwd().
// Errors are left to reject naturally — the engine's tool executor is
// responsible for turning a rejected handler promise into whatever
// error/toolResult shape it uses; we don't hand-roll a synthetic {isError}.

import { readFile as fsReadFile, readdir } from "node:fs/promises";
import path from "node:path";
import { tool, provide } from "@behalf-js/core";
import type { Binding } from "@behalf-js/core";
import { z } from "zod";

function resolvePath(input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

export const readFile = tool<{ path: string }, { content: string }>(
  "read",
  "Read a UTF-8 text file from disk and return its contents.",
  z.object({ path: z.string() }),
);

export const listDirectory = tool<{ path: string }, { entries: string[] }>(
  "list_directory",
  "List the entries (files and subdirectories) of a directory.",
  z.object({ path: z.string() }),
);

export const getCwd = tool<Record<string, never>, { cwd: string }>(
  "cwd",
  "Return the process's current working directory.",
  z.object({}),
);

const readFileBinding: Binding = provide(readFile, async ({ path: target }) => {
  const content = await fsReadFile(resolvePath(target), "utf-8");
  return { content };
});

const listDirectoryBinding: Binding = provide(listDirectory, async ({ path: target }) => {
  const entries = await readdir(resolvePath(target));
  return { entries };
});

const getCwdBinding: Binding = provide(getCwd, async () => ({ cwd: process.cwd() }));

// M5 — deliberately slow, progress-streaming recursive search. Walks the
// directory tree under `path` via real `readdir`/`readFile` I/O (no
// artificial delay — a real tree is slow enough on its own) and reports a
// substring match's file + line number. Emits a delta after every file it
// scans, tagged with the tool call's own `correlationId`, so the UI can
// correlate progress back to the right tool card while the search runs.
export const searchFiles = tool<
  { path: string; query: string },
  { matches: { file: string; line: number }[] }
>(
  "search_files",
  "Recursively search files under a directory for a substring match.",
  z.object({ path: z.string(), query: z.string() }),
);

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

const searchFilesBinding: Binding = provide(
  searchFiles,
  async ({ path: target, query }, context) => {
    const root = resolvePath(target);
    const files = await collectFiles(root);
    const stream = context.openStream("output");
    const matches: { file: string; line: number }[] = [];
    let scanned = 0;
    for (const file of files) {
      try {
        const content = await fsReadFile(file, "utf-8");
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index++) {
          if (lines[index].includes(query)) matches.push({ file, line: index + 1 });
        }
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
  },
);

// `Tool` refs, for `Profile.tools`.
export const fsTools = [readFile, listDirectory, getCwd, searchFiles];

// `Binding`s, for `runtime({ bindings })`.
export const fsBindings = [
  readFileBinding,
  listDirectoryBinding,
  getCwdBinding,
  searchFilesBinding,
];
