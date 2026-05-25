#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const flowRoot = join(scriptDir, "..");
const stateDir = mkdtempSync(join(tmpdir(), "flow-smoke-"));
const repoRoot = join(stateDir, "project");
const statePath = join(stateDir, "state.json");
const originalCwd = process.cwd();
const sdkModulePath = join(flowRoot, "test-runtime", "pi-sdk-mock.mjs").replace(/\\/g, "/");

try {
  buildFlow();

  mkdirSync(join(repoRoot, ".flow"), { recursive: true });
  writeFileSync(join(repoRoot, ".flow", "config.yaml"), [
    'version: "1"',
    "project:",
    '  name: "smoke"',
    "topology:",
    "  repos:",
    "    main:",
    '      name: "smoke"',
    "runtime:",
    "  worker:",
    `    sdkModulePath: "${sdkModulePath}"`,
    "",
  ].join("\n"));
  globalThis.flowSmokeStatePath = statePath;
  process.chdir(repoRoot);
  const flowRuntimeEntry = join(flowRoot, "dist", "bin", "src", "flow-runtime.js");
  const { runFlowPrompt } = await import(`${pathToFileURL(flowRuntimeEntry).href}?t=${Date.now()}`);
  const result = await runFlowPrompt({ noSession: true, prompt: "Reply with exactly: OK" });
  if (result.text !== "OK") {
    throw new Error(`expected OK response, got ${result.text}`);
  }

  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (!state.loaderOptions?.agentDir) {
    throw new Error("loader options missing agentDir");
  }
  if (state.loaderOptions?.noContextFiles !== true) {
    throw new Error("loader options did not disable context files");
  }
  if (!state.sessionOptions?.tools?.every((tool) => tool.startsWith("flow_"))) {
    throw new Error("session tools are not restricted to flow_*");
  }
  if (realpathSync(state.sessionOptions?.cwd) !== realpathSync(repoRoot)) {
    throw new Error(`session cwd should be project root, got ${state.sessionOptions?.cwd}`);
  }
  if (state.sessionOptions?.model?.provider !== "openrouter") {
    throw new Error(`default provider should be openrouter, got ${state.sessionOptions?.model?.provider}`);
  }
  if (state.sessionOptions?.model?.modelId !== "google/gemini-3.5-flash") {
    throw new Error(`default model should be google/gemini-3.5-flash, got ${state.sessionOptions?.model?.modelId}`);
  }

  console.log("flow smoke: ok");
} finally {
  process.chdir(originalCwd);
  rmSync(stateDir, { recursive: true, force: true });
}

function buildFlow() {
  const configPath = ts.findConfigFile(flowRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error(`Missing tsconfig.json under ${flowRoot}`);

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(formatDiagnostics([config.error]));

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, flowRoot, undefined, configPath);
  if (parsed.errors.length) throw new Error(formatDiagnostics(parsed.errors));

  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const emit = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emit.diagnostics);
  if (diagnostics.length) throw new Error(formatDiagnostics(diagnostics));
  if (emit.emitSkipped) throw new Error("TypeScript emit was skipped.");
}

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => "\n",
  });
}
