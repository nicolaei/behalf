// M3 — real filesystem tools: read_file, list_directory, get_cwd. Handlers do
// real I/O (node:fs/promises) and resolve relative paths against process.cwd().
// Errors are left to reject naturally — the engine's tool executor is
// responsible for turning a rejected handler promise into whatever
// error/toolResult shape it uses; we don't hand-roll a synthetic {isError}.

import { readFile as fsReadFile, readdir } from "node:fs/promises";
import path from "node:path";
import { tool, provide } from "behalf";
import type { Binding } from "behalf";
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

// `Tool` refs, for `Profile.tools`.
export const fsTools = [readFile, listDirectory, getCwd];

// `Binding`s, for `runtime({ bindings })`.
export const fsBindings = [readFileBinding, listDirectoryBinding, getCwdBinding];
