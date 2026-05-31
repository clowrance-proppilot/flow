#!/usr/bin/env node
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Test categories for Flow.
 *
 * Each key maps to a regex pattern used with node:test's `testNamePatterns`
 * option (available since Node.js v20.15.0 / v22.2.0).
 *
 * Categories may overlap; `npm test` always runs the full suite.
 */
const CATEGORIES = {
  config:
    "config|Config|topology|Topology|work type|createId|branch kind|branchPattern",
  runtime:
    "Work Runtime (?!reconciliation|doctor)|Flow CLI|Local issue|Local thread|Work envelope|autoflow|Autoflow|Beads",
  desktop: "Desktop|Pi |project theme|Project theme",
  dashboard: "Dashboard",
  readiness: "Readiness",
  ledger: "ledger|Ledger|JSONL|context record",
  adapters:
    "Jira adapter|GitHub adapter|GitHub issue|Provider CLI|auto review must-fix|auto review sections|pull request check|pull request template|pull request lifecycle",
  reconciliation: "Work Runtime reconciliation|Work Runtime doctor",
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const flowRoot = join(scriptDir, "..");
const outDir = join(flowRoot, ".tmp", "test");

// --- CLI flags ---------------------------------------------------------------

let category = null;
let testNamePattern = null;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--category" && i + 1 < process.argv.length) {
    category = process.argv[++i];
  } else if (arg === "--test-name-pattern" && i + 1 < process.argv.length) {
    testNamePattern = process.argv[++i];
  } else if (arg === "--list-categories") {
    for (const [name, pattern] of Object.entries(CATEGORIES)) {
      console.log(`${name}\t${pattern}`);
    }
    process.exit(0);
  }
}

if (category && !(category in CATEGORIES)) {
  console.error(
    `Unknown test category: "${category}".\nAvailable categories: ${Object.keys(CATEGORIES).join(", ")}`,
  );
  process.exit(1);
}

const effectivePattern = testNamePattern ?? (category ? CATEGORIES[category] : null);

// --- Build & run -------------------------------------------------------------

rmSync(outDir, { recursive: true, force: true });
buildFlow();

const testFiles = [
  join(outDir, "test", "flow.test.js"),
  join(outDir, "test", "dashboard-state.test.js"),
];

await runTests(testFiles, effectivePattern);

// --- Helpers -----------------------------------------------------------------

function buildFlow() {
  const packageRoot = flowRoot;
  const configPath = ts.findConfigFile(
    packageRoot,
    ts.sys.fileExists,
    "tsconfig.json",
  );
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
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .concat(emit.diagnostics);
  if (diagnostics.length) throw new Error(formatDiagnostics(diagnostics));
  if (emit.emitSkipped) throw new Error("TypeScript emit was skipped.");
}

async function runTests(files, testNamePatterns) {
  const runOptions = { files };
  if (testNamePatterns) {
    runOptions.testNamePatterns = testNamePatterns;
  }

  const stream = run(runOptions);
  const counts = { pass: 0, fail: 0, skip: 0 };
  const failures = [];

  for await (const event of stream) {
    if (event.type === "test:pass") {
      if (event.data?.details?.todo) counts.skip += 1;
      else counts.pass += 1;
    }
    if (event.type === "test:fail") {
      counts.fail += 1;
      failures.push(event.data?.name ?? "unknown test");
    }
  }

  if (counts.fail > 0) {
    throw new Error(`flow-runtime tests failed: ${failures.join(", ")}`);
  }

  const parts = [`flow-runtime tests: ${counts.pass} passed`];
  if (counts.skip > 0) parts.push(`${counts.skip} skipped`);
  if (testNamePatterns) parts.push(`(pattern: ${testNamePatterns})`);
  console.log(parts.join(", "));
}

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => flowRoot,
    getNewLine: () => "\n",
  });
}
