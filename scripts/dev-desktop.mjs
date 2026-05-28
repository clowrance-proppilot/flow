import { context } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const viteBin = resolve(root, "node_modules", "vite", "bin", "vite.js");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const runtimeDeps = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
];
const nodeBuiltins = [...new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.startsWith("node:") ? name : `node:${name}`),
])];
const externals = [...new Set(["electron", ...runtimeDeps, ...nodeBuiltins])];

let shuttingDown = false;
let electronChild = null;
let electronRestartInFlight = false;
let restartTimer = null;
let mainReady = false;
let preloadReady = false;

// Build main and preload with watch
const mainCtx = await context({
  entryPoints: [resolve(root, "desktop/main.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: resolve(root, "dist/desktop/main.js"),
  external: externals,
  sourcemap: true,
  resolveExtensions: [".ts", ".js"],
  loader: { ".ts": "ts" },
  plugins: [restartOnSuccessfulBuild("main")],
});

const preloadCtx = await context({
  entryPoints: [resolve(root, "desktop/preload.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  outfile: resolve(root, "dist/desktop/preload.js"),
  external: externals,
  sourcemap: true,
  resolveExtensions: [".ts", ".js"],
  loader: { ".ts": "ts" },
  plugins: [restartOnSuccessfulBuild("preload")],
});

const rendererWatch = spawn(process.execPath, [
  viteBin,
  "build",
  "--config",
  resolve(root, "vite.desktop.config.ts"),
  "--watch",
], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env },
});

rendererWatch.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.error(`[dev-desktop] renderer watch exited: code=${code ?? ""} signal=${signal ?? ""}`);
  shutdown();
  process.exit(code ?? 1);
});

await Promise.all([mainCtx.watch(), preloadCtx.watch()]);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => shutdown(signal));
}

process.on("exit", () => {
  shutdown("SIGTERM");
});

function restartOnSuccessfulBuild(target) {
  return {
    name: `dev-desktop-restart-${target}`,
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        if (target === "main") mainReady = true;
        if (target === "preload") preloadReady = true;
        scheduleElectronRestart();
      });
    },
  };
}

function scheduleElectronRestart() {
  if (!mainReady || !preloadReady || shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (shuttingDown) return;
    restartElectron();
  }, 120);
}

async function restartElectron() {
  if (!mainReady || !preloadReady || shuttingDown) return;
  if (!electronChild || electronChild.exitCode !== null || electronChild.signalCode !== null) {
    await startElectron();
    return;
  }
  if (electronRestartInFlight) return;
  electronRestartInFlight = true;
  electronChild.kill("SIGTERM");
  setTimeout(() => {
    if (!electronChild || electronChild.exitCode !== null || electronChild.signalCode !== null) return;
    electronChild.kill("SIGKILL");
  }, 1500).unref();
}

async function startElectron() {
  const electron = await import("electron");
  const electronBin = String(electron.default);
  const child = spawn(electronBin, [resolve(root, "dist/desktop/main.js")], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      FLOW_DESKTOP_AUTO_RELOAD: "1",
    },
  });
  electronChild = child;
  child.on("exit", async (code, signal) => {
    if (shuttingDown) return;
    if (electronRestartInFlight) {
      electronRestartInFlight = false;
      await startElectron();
      return;
    }
    console.log(`[dev-desktop] electron exited: code=${code ?? ""} signal=${signal ?? ""}`);
    shutdown();
    process.exit(code ?? 0);
  });
}

function shutdown(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (rendererWatch && rendererWatch.exitCode === null && rendererWatch.signalCode === null) {
    rendererWatch.kill(signal);
  }
  if (electronChild && electronChild.exitCode === null && electronChild.signalCode === null) {
    electronChild.kill(signal);
  }
}
