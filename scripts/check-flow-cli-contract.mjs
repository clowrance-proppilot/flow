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

const violations = [];

checkAbsent(/\.option\(\s*["'`]--json\b/m, "Flow CLI commands must not expose --json; stdout is always JSON.");
checkAbsent(/\bconsole\.(log|info|warn|error)\s*\(/m, "Flow CLI must use writeJson for stdout and process.stderr for diagnostics.");
checkAbsent(/from\s+["']commander["']/m, "Flow CLI must not use Commander; the agent surface is a JSON body transport.");
const stdoutWrites = [...source.matchAll(/\bprocess\.stdout\.write\s*\(/g)];
if (stdoutWrites.length !== 1) {
  violations.push("Flow CLI must have exactly one stdout write, inside writeJson.");
}

if (!/function writeJson\(value: unknown\): void \{\s*process\.stdout\.write\(`\$\{JSON\.stringify\(value\)\}\\n`\);\s*\}/m.test(jsonCliSource)) {
  violations.push("Flow CLI writeJson must remain the only stdout serializer and must emit JSON.");
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
