import assert from "node:assert/strict";
import test from "node:test";

// Forbidden import patterns from check-core-import-boundary.mjs
const forbiddenImportPatterns: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /from\s+["']\.\/autoflow-runner(?:\.js)?["']/, label: "autoflow-runner" },
  { pattern: /from\s+["']\.\/autoflow-service(?:\.js)?["']/, label: "autoflow-service" },
  { pattern: /from\s+["']\.\/agent-session-driver(?:\.js)?["']/, label: "agent-session-driver" },
  { pattern: /from\s+["']\.\/claude-agent-runner(?:\.js)?["']/, label: "claude-agent-runner" },
  { pattern: /from\s+["']\.\/claude-session-driver(?:\.js)?["']/, label: "claude-session-driver" },
  { pattern: /from\s+["']\.\/pi-sdk-runner(?:\.js)?["']/, label: "pi-sdk-runner" },
  { pattern: /from\s+["']\.\/pi-session-driver(?:\.js)?["']/, label: "pi-session-driver" },
  { pattern: /from\s+["']\.\/execution-plane(?:\.js)?["']/, label: "execution-plane" },
  { pattern: /from\s+["']\.\/hatchet-execution(?:\.js)?["']/, label: "hatchet-execution" },
  { pattern: /from\s+["']\.\.\/desktop\//, label: "desktop/" },
  { pattern: /from\s+["']\.\/desktop\//, label: "desktop/" },
];

function detectForbiddenImport(source: string): string | null {
  for (const { pattern, label } of forbiddenImportPatterns) {
    if (pattern.test(source)) return label;
  }
  return null;
}

test("detects forbidden autoflow-runner import", () => {
  const source = `import { AutoflowRunner } from "./autoflow-runner.js";`;
  assert.equal(detectForbiddenImport(source), "autoflow-runner");
});

test("detects forbidden autoflow-service import", () => {
  const source = `import { AutoflowService } from "./autoflow-service";`;
  assert.equal(detectForbiddenImport(source), "autoflow-service");
});

test("detects forbidden agent-session-driver import", () => {
  const source = `import { AgentSessionDriver } from "./agent-session-driver.js";`;
  assert.equal(detectForbiddenImport(source), "agent-session-driver");
});

test("detects forbidden claude-agent-runner import", () => {
  const source = `import { ClaudeAgentRunner } from "./claude-agent-runner.js";`;
  assert.equal(detectForbiddenImport(source), "claude-agent-runner");
});

test("detects forbidden claude-session-driver import", () => {
  const source = `import { ClaudeSessionDriver } from "./claude-session-driver.js";`;
  assert.equal(detectForbiddenImport(source), "claude-session-driver");
});

test("detects forbidden pi-sdk-runner import", () => {
  const source = `import { PiSdkSessionRunner } from "./pi-sdk-runner.js";`;
  assert.equal(detectForbiddenImport(source), "pi-sdk-runner");
});

test("detects forbidden pi-session-driver import", () => {
  const source = `import { PiSessionDriver } from "./pi-session-driver.js";`;
  assert.equal(detectForbiddenImport(source), "pi-session-driver");
});

test("detects forbidden execution-plane import", () => {
  const source = `import type { AutoflowExecutionRequest } from "./execution-plane.js";`;
  assert.equal(detectForbiddenImport(source), "execution-plane");
});

test("detects forbidden hatchet-execution import", () => {
  const source = `import { HatchetAutoflowRunner } from "./hatchet-execution.js";`;
  assert.equal(detectForbiddenImport(source), "hatchet-execution");
});

test("detects forbidden desktop import", () => {
  const source = `import { something } from "../desktop/main.js";`;
  assert.equal(detectForbiddenImport(source), "desktop/");
});

test("allows legitimate core imports", () => {
  const source = `
    import { FlowWorkRuntime } from "./work-runtime.js";
    import { createConfiguredWorkRuntime } from "./runtime-factory.js";
    import { repoRoot } from "./flow-runtime.js";
    import { JsonCliError } from "./json-cli.js";
  `;
  assert.equal(detectForbiddenImport(source), null);
});

test("allows contracts imports", () => {
  const source = `import type { WorkItem } from "./contracts.js";`;
  assert.equal(detectForbiddenImport(source), null);
});

test("allows config imports", () => {
  const source = `import { loadFlowConfig } from "./config/config-loader.js";`;
  assert.equal(detectForbiddenImport(source), null);
});
