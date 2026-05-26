#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const flowRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const flowCliPath = join(flowRoot, "src", "flow.ts");
const jsonCliPath = join(flowRoot, "src", "json-cli.ts");
const flowSource = readFileSync(flowCliPath, "utf8");
const jsonCliSource = readFileSync(jsonCliPath, "utf8");
const source = `${flowSource}\n${jsonCliSource}`;
const coreContractFiles = [
  "src/contracts/executor.ts",
  "src/contracts/work.ts",
  "src/contracts/runtime.ts",
  "src/work-registry.ts",
  "src/work-runtime.ts",
  "src/config/config-schema.ts",
  "src/config/config-loader.ts",
  "src/flow-runtime.ts",
];
const coreSource = coreContractFiles
  .map((path) => readFileSync(join(flowRoot, path), "utf8"))
  .join("\n");

const violations = [];

checkAbsent(/\.option\(\s*["'`]--json\b/m, "Flow CLI commands must not expose --json; stdout is always JSON.");
checkAbsent(/\bconsole\.(log|info|warn|error)\s*\(/m, "Flow CLI must use writeJson for stdout and process.stderr for diagnostics.");
checkAbsent(/from\s+["']commander["']/m, "Flow CLI must not use Commander; the agent surface is a JSON body transport.");
checkCoreAbsent(/\bpi_worker\b|\bcodex_worker\b|\bspawn_worker\b|\bflow_run_background_executor\b|\bcreateDefaultWorkerSpawner\b|\brunFlowPrompt\b/m, "Flow core must not expose Pi, Codex, or background worker orchestration.");
checkCoreAbsent(/runtime\.worker|sdkModulePath|codexCommand|DEFAULT_PI|DEFAULT_AGENT/m, "Flow core must not expose worker provider runtime config.");
const stdoutWrites = [...source.matchAll(/\bprocess\.stdout\.write\s*\(/g)];
if (stdoutWrites.length !== 1) {
  violations.push("Flow CLI must have exactly one stdout write, inside writeJson.");
}

if (!/function writeJson\(value: unknown\): void \{\s*process\.stdout\.write\(`\$\{JSON\.stringify\(value\)\}\\n`\);\s*\}/m.test(jsonCliSource)) {
  violations.push("Flow CLI writeJson must remain the only stdout serializer and must emit JSON.");
}
if (!/\["manifest", "help", "--help", "-h"\]\.includes\(argv\[0\]\)/m.test(jsonCliSource)) {
  violations.push("Flow CLI must support flow --help as a JSON manifest alias.");
}

if (violations.length > 0) {
  console.error("Flow CLI JSON contract check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("flow cli contract: ok");

function checkAbsent(pattern, message) {
  if (pattern.test(source)) violations.push(message);
}

function checkCoreAbsent(pattern, message) {
  if (pattern.test(coreSource)) violations.push(message);
}
