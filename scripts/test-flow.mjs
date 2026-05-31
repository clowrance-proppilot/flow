#!/usr/bin/env node
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const flowRoot = join(scriptDir, "..");
const outDir = join(flowRoot, ".tmp", "test");

rmSync(outDir, { recursive: true, force: true });
buildFlow();
await runTests([
  join(outDir, "test", "flow.test.js"),
  join(outDir, "test", "dashboard-state.test.js"),
  join(outDir, "test", "sql-state.test.js"),
  join(outDir, "test", "sql-store.test.js"),
]);

function buildFlow() {
  const packageRoot = flowRoot;
  const configPath = ts.findConfigFile(packageRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("Missing flow/tsconfig.json");

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(formatDiagnostics([config.error]));

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    packageRoot,
    {
      outDir,
      rootDir: packageRoot,
      noEmit: false,
    },
    configPath,
  );
  if (parsed.errors.length) throw new Error(formatDiagnostics(parsed.errors));

  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const emit = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emit.diagnostics);
  if (diagnostics.length) throw new Error(formatDiagnostics(diagnostics));
  if (emit.emitSkipped) throw new Error("TypeScript emit was skipped.");
}

async function runTests(files) {
  const stream = run({ files });
  const counts = { pass: 0, fail: 0 };
  const failures = [];

  for await (const event of stream) {
    if (event.type === "test:pass") counts.pass += 1;
    if (event.type === "test:fail") {
      counts.fail += 1;
      failures.push(event.data?.name ?? "unknown test");
    }
  }

  if (counts.fail > 0) {
    throw new Error(`flow-runtime tests failed: ${failures.join(", ")}`);
  }
  console.log(`flow-runtime tests: ${counts.pass} passed`);
}

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => flowRoot,
    getNewLine: () => "\n",
  });
}
