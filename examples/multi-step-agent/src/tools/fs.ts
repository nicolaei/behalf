// Write-capable filesystem + shell tools for the red/green/refactor stages.
// Follows simple-chat/src/tools.ts's conventions: real I/O (node:fs/promises,
// node:child_process), relative paths resolved against process.cwd(), errors
// left to reject naturally. This is a demo, not a hardened sandbox — no path
// jailing, no command allowlist.

import { writeFile as fsWriteFile, readFile as fsReadFile, mkdir } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tool, provide } from "behalf";
import type { Binding } from "behalf";
import { z } from "zod";

const execAsync = promisify(exec);

function resolvePath(input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

export const writeFile = tool<{ path: string; content: string }, { path: string }>(
  "write_file",
  "Write a UTF-8 string to a file, creating it (and any parent directories) if needed.",
  z.object({ path: z.string(), content: z.string() }),
);

export const editFile = tool<
  { path: string; find: string; replace: string },
  { path: string }
>(
  "edit_file",
  "Perform one literal find-replace in a file's contents (not a regex).",
  z.object({ path: z.string(), find: z.string(), replace: z.string() }),
);

export const runBash = tool<
  { command: string },
  { stdout: string; stderr: string; exitCode: number }
>(
  "run_bash",
  "Run a shell command and return its stdout, stderr, and exit code.",
  z.object({ command: z.string() }),
);

const writeFileBinding: Binding = provide(writeFile, async ({ path: target, content }) => {
  const resolved = resolvePath(target);
  await mkdir(path.dirname(resolved), { recursive: true });
  await fsWriteFile(resolved, content, "utf-8");
  return { path: resolved };
});

const editFileBinding: Binding = provide(editFile, async ({ path: target, find, replace }) => {
  const resolved = resolvePath(target);
  const content = await fsReadFile(resolved, "utf-8");
  if (!content.includes(find)) {
    throw new Error(`edit_file: "find" text not found in ${resolved}`);
  }
  await fsWriteFile(resolved, content.replace(find, replace), "utf-8");
  return { path: resolved };
});

// A red test's `npm test` failing IS the expected/useful result — don't
// throw non-zero exits away as a rejected promise, the model needs to see
// stdout/stderr to judge red vs. green.
const runBashBinding: Binding = provide(runBash, async ({ command }) => {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd: process.cwd() });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error),
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
});

// `Tool` refs, for `Profile.tools`.
export const fsTools = [writeFile, editFile, runBash];

// `Binding`s, for `runtime({ bindings })`.
export const fsBindings = [writeFileBinding, editFileBinding, runBashBinding];
