// pack-manifest — swaps a package's `exports` (and `main`/`types`) between the
// source shape kept in git and the dist shape a published tarball needs.
//
// Git keeps every entry point pointing at `./src/*.ts`, so in-repo consumers
// (this workspace's tests, and cockpit's `file:` deps) resolve straight to
// source with no build step. npm's `prepack` runs this in `dist` mode to point
// the manifest at the compiled `./dist/*.js`/`*.d.ts`; `postpack` runs it in
// `src` mode to put the checkout back the way git left it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const SOURCE = /^\.\/src\/(.+)\.ts$/;
const DIST = /^\.\/dist\/(.+)\.js$/;

function distPath(source) {
  const match = SOURCE.exec(source);
  if (!match) throw new Error(`not a source export path: ${source}`);
  return `./dist/${match[1]}`;
}

function sourcePath(dist) {
  const match = DIST.exec(dist);
  if (!match) throw new Error(`not a dist export path: ${dist}`);
  return `./src/${match[1]}.ts`;
}

/** Rewrites source exports to `{ types, default }` dist objects, and adds `main`/`types`. Throws if a referenced dist file is missing. */
export function toDist(manifest, exists = existsSync) {
  const exports = {};
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    const base = distPath(value);
    const js = `${base}.js`;
    if (!exists(js)) throw new Error(`missing ${js} — build before packing`);
    exports[key] = { types: `${base}.d.ts`, default: js };
  }
  const root = exports["."];
  if (!root) throw new Error('no "." export');
  return { ...manifest, main: root.default, types: root.types, exports };
}

/** Reverses {@link toDist}: dist export objects become source paths, and `main`/`types` are dropped. */
export function toSrc(manifest) {
  const exports = {};
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    const dist = typeof value === "string" ? value : value?.default;
    exports[key] = sourcePath(dist);
  }
  const { main: _main, types: _types, ...rest } = manifest;
  return { ...rest, exports };
}

const mode = process.argv[2];
if (mode !== "dist" && mode !== "src") {
  console.error("usage: node pack-manifest.mjs <dist|src>");
  process.exit(1);
}

const path = "package.json";
const manifest = JSON.parse(readFileSync(path, "utf8"));
const next = mode === "dist" ? toDist(manifest) : toSrc(manifest);
writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
