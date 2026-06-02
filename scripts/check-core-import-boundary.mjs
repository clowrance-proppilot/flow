#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const flowRoot = join(fileURLToPath(new URL("..", import.meta.url)));

// Core CLI modules that must not import experimental orchestration code.
const coreModules = [
  "src/flow.ts",
  "src/json-cli.ts",
  "src/flow-runtime.ts",
  "src/work-runtime.ts",
  "src/contracts.ts",
  "src/work-registry.ts",
  "src/config/config-schema.ts",
  "src/config/config-loader.ts",
  "src/runtime-factory.ts",
  "src/dispatch-validators.ts",
  "src/cli-issue.ts",
];

// Experimental orchestration modules that core must not depend on.
const forbiddenImportPatterns = [
  /from\s+["']\.\/autoflow-runner(?:\.js)?["']/,
  /from\s+["']\.\/autoflow-service(?:\.js)?["']/,
  /from\s+["']\.\/agent-session-driver(?:\.js)?["']/,
  /from\s+["']\.\/claude-agent-runner(?:\.js)?["']/,
  /from\s+["']\.\/claude-session-driver(?:\.js)?["']/,
  /from\s+["']\.\/pi-sdk-runner(?:\.js)?["']/,
  /from\s+["']\.\/pi-session-driver(?:\.js)?["']/,
  /from\s+["']\.\/execution-plane(?:\.js)?["']/,
  /from\s+["']\.\/hatchet-execution(?:\.js)?["']/,
  /from\s+["']\.\.\/desktop\//,
  /from\s+["']\.\/desktop\//,
];

const forbiddenModuleLabels = [
  "autoflow-runner",
  "autoflow-service",
  "agent-session-driver",
  "claude-agent-runner",
  "claude-session-driver",
  "pi-sdk-runner",
  "pi-session-driver",
  "execution-plane",
  "hatchet-execution",
  "desktop/",
];

const violations = [];

for (const relPath of coreModules) {
  let source;
  try {
    source = readFileSync(join(flowRoot, relPath), "utf8");
  } catch {
    violations.push(`Core module ${relPath} is missing.`);
    continue;
  }

  for (let i = 0; i < forbiddenImportPatterns.length; i++) {
    if (forbiddenImportPatterns[i].test(source)) {
      violations.push(
        `Core module ${relPath} must not import experimental orchestration module ${forbiddenModuleLabels[i]}.`
      );
    }
  }
}

if (violations.length > 0) {
  console.error("Core import boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("core import boundary: ok");
