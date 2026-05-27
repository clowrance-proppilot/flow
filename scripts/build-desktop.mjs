import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const allDeps = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  "electron",
];

// Bundle main process — ESM
await build({
  entryPoints: [resolve(root, "desktop/main.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: resolve(root, "dist/desktop/main.js"),
  external: allDeps,
  sourcemap: true,
  resolveExtensions: [".ts", ".js"],
  loader: { ".ts": "ts" },
});

// Bundle preload — CJS (required by Electron preload)
await build({
  entryPoints: [resolve(root, "desktop/preload.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  outfile: resolve(root, "dist/desktop/preload.js"),
  external: allDeps,
  sourcemap: true,
  resolveExtensions: [".ts", ".js"],
  loader: { ".ts": "ts" },
});

console.log("[build-desktop] dist/desktop/main.js");
console.log("[build-desktop] dist/desktop/preload.js");
