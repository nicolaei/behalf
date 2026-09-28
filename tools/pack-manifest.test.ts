// pack-manifest — `prepack` points a package's exports at compiled `./dist`,
// `postpack` puts them back at `./src`. A published tarball must resolve to
// dist while the checkout git sees stays on source, so the round trip has to be
// exact, and packing has to fail loudly rather than ship a manifest pointing at
// a dist file that was never built.
import { describe, it, expect } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

interface Manifest {
  exports: Record<string, unknown>;
  main?: string;
  types?: string;
}

const tool = fileURLToPath(new URL("./pack-manifest.mjs", import.meta.url));
const fixture = fileURLToPath(
  new URL("./__fixtures__/pack-manifest/package.json", import.meta.url),
);

function parse(text: string): Manifest {
  return JSON.parse(text) as Manifest;
}

function scratch() {
  return mkdtempSync(path.join(tmpdir(), "pack-manifest-"));
}

function run(cwd: string, mode: string) {
  return spawnSync(process.execPath, [tool, mode], { cwd, encoding: "utf8" });
}

function manifest(dir: string): Manifest {
  return parse(readFileSync(path.join(dir, "package.json"), "utf8"));
}

function writeDist(dir: string, entry: string) {
  const file = path.join(dir, "dist", entry);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
}

describe("pack-manifest", () => {
  it("points source exports at dist, then restores them exactly", () => {
    const dir = scratch();
    try {
      const source = readFileSync(fixture, "utf8");
      writeFileSync(path.join(dir, "package.json"), source);
      for (const entry of ["index", "internal", "ai/index"]) writeDist(dir, `${entry}.js`);

      expect(run(dir, "dist").status).toBe(0);
      expect(manifest(dir).exports).toEqual({
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./internal": { types: "./dist/internal.d.ts", default: "./dist/internal.js" },
        "./ai": { types: "./dist/ai/index.d.ts", default: "./dist/ai/index.js" },
      });
      expect(manifest(dir).main).toBe("./dist/index.js");
      expect(manifest(dir).types).toBe("./dist/index.d.ts");

      expect(run(dir, "src").status).toBe(0);
      expect(manifest(dir)).toEqual(parse(source));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write when a dist file is missing", () => {
    const dir = scratch();
    try {
      const source = readFileSync(fixture, "utf8");
      writeFileSync(path.join(dir, "package.json"), source);
      writeDist(dir, "index.js");

      expect(run(dir, "dist").status).not.toBe(0);
      expect(manifest(dir)).toEqual(parse(source));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
