// The engine boundary test, kept from B3.0 as a cheap guard — not as the
// proof. graph/, session/, gateway/, and runtime/ must not import from `ai/`
// at all. Not as a type, not as a value, not behind an
// eslint-disable-next-line.
//
// This is stricter than the eslint rule it backstops, deliberately. The lint
// rule can be silenced per line, and during B2 it was: eleven call sites
// carried a `TODO(B2 step N)` disable comment recording a deferred decision.
// That made the layering claim ("ai depends on the engine, never the reverse")
// true only by convention. So this test reads the source, not the lint config:
// it counts every import specifier crossing into `ai/` and requires zero.
//
// Since B3.1 the four directories live in their own package, which does not
// depend on `@behalf-js/core` — so a crossing import mostly cannot even
// resolve. What this scan still buys is an early, specific failure naming the
// offending file, and coverage of type-only imports.
//
// What it does NOT prove, and never could: it is a source-text scan, blind to
// a coupling expressed as a string literal. It missed exactly one of those
// (the hardcoded `"message"` event type in the replay path, generalized in
// B3.1 to `EngineExtension.inboxMessageOf`). The real proof is its neighbour,
// `engine-runs-a-graph.test.ts`, which builds and runs the thing.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const ENGINE_DIRS = ["graph", "session", "gateway", "runtime"];

/** Every `.ts` file under `dir`, recursively. */
function tsFilesIn(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...tsFilesIn(path));
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
}

/**
 * Import specifiers in `source` that resolve into `ai/`. Matches `import`,
 * `export ... from`, and bare side-effect imports alike, type-only or not —
 * `import type` still couples the packages at build time, which is exactly
 * what the extraction has to survive.
 */
function aiImportsIn(source: string): string[] {
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"|import\s+"([^"]+)"/g)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
  return specifiers.filter((specifier) => /(^|\/)ai\//.test(specifier));
}

describe("the engine layer is ai-free", () => {
  for (const dir of ENGINE_DIRS) {
    it(`${dir}/ imports nothing from ai/`, () => {
      const offenders: string[] = [];
      for (const file of tsFilesIn(join(SRC, dir))) {
        for (const specifier of aiImportsIn(readFileSync(file, "utf8"))) {
          offenders.push(`${file.slice(SRC.length)} → ${specifier}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
