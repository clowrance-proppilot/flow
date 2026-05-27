import { context } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// Build main and preload with watch
const mainCtx = await context({
  entryPoints: [resolve(root, "desktop/main.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: resolve(root, "dist/desktop/main.js"),
  external: ["electron"],
  sourcemap: true,
  resolveExtensions: [".ts", ".js"],
  loader: { ".ts": "ts" },
});

const preloadCtx = await context({
  entryPoints: [resolve(root, "desktop/preload.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  outfile: resolve(root, "dist/desktop/preload.js"),
  external: ["electron"],
  sourcemap: true,
  resolveExtensions: [".ts", ".js"],
  loader: { ".ts": "ts" },
});

await Promise.all([mainCtx.watch(), preloadCtx.watch()]);

// Start Electron
const electronBin = resolve(root, "node_modules/.bin/electron");
const child = spawn(electronBin, [resolve(root, "dist/desktop/main.js")], {
  stdio: "inherit",
  env: { ...process.env },
});

child.on("close", (code) => {
  process.exit(code ?? 0);
});
