/**
 * Flow CLI Protocol - Programmatic Usage Example
 *
 * This example demonstrates how to call the Flow CLI programmatically
 * from TypeScript/JavaScript using child_process.
 *
 * Flow uses a JSON protocol:
 * - Send one JSON body per invocation
 * - Receive one JSON document on stdout
 */

import { execFileSync } from "node:child_process";

interface FlowResponse {
  ok: boolean;
  op?: string;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    hint?: string;
  };
}

/**
 * Call the Flow CLI with a JSON body and parse the response.
 */
function callFlow(body: Record<string, unknown>, options?: { cwd?: string }): FlowResponse {
  const stdout = execFileSync("flow", [JSON.stringify(body)], {
    encoding: "utf8",
    cwd: options?.cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/**
 * Example: Get the compact manifest
 */
function getManifest(): void {
  const response = callFlow({ op: "manifest" });
  console.log("Manifest:", JSON.stringify(response.result, null, 2));
}

/**
 * Example: Get targeted manifest for workflow operations
 */
function getWorkflowManifest(): void {
  const response = callFlow({ op: "manifest", target: "workflow" });
  console.log("Workflow Manifest:", JSON.stringify(response.result, null, 2));
}

/**
 * Example: Read current Flow state
 */
function getState(sessionId?: string): unknown {
  const body: Record<string, unknown> = { op: "state" };
  if (sessionId) body.id = sessionId;
  const response = callFlow(body);
  if (!response.ok) {
    throw new Error(`Flow state failed: ${response.error?.message}`);
  }
  return response.result;
}

/**
 * Example: Inspect the issue queue
 */
function inspectQueue(limit = 10): unknown[] {
  const response = callFlow({ op: "queue", limit });
  if (!response.ok) {
    throw new Error(`Flow queue failed: ${response.error?.message}`);
  }
  return response.result as unknown[];
}

/**
 * Example: View an issue
 */
function viewIssue(issueId: string): unknown {
  const response = callFlow({ op: "issue", mode: "view", id: issueId });
  if (!response.ok) {
    throw new Error(`Flow issue view failed: ${response.error?.message}`);
  }
  return response.result;
}

/**
 * Example: Create a new issue
 */
function createIssue(summary: string, description?: string): unknown {
  const body: Record<string, unknown> = {
    op: "issue",
    mode: "create",
    summary,
  };
  if (description) body.description = description;
  const response = callFlow(body);
  if (!response.ok) {
    throw new Error(`Flow issue create failed: ${response.error?.message}`);
  }
  return response.result;
}

/**
 * Example: Record a work result
 */
function recordResult(
  issueId: string,
  repoKey: string,
  summary: string,
  testsRun?: string[],
): unknown {
  const body: Record<string, unknown> = {
    op: "workflow",
    mode: "recordResult",
    id: issueId,
    repoKey,
    summary,
  };
  if (testsRun) body.testsRun = testsRun;
  const response = callFlow(body);
  if (!response.ok) {
    throw new Error(`Flow record result failed: ${response.error?.message}`);
  }
  return response.result;
}

/**
 * Example: Run autoflow on an issue
 */
function autoFlow(issueId: string, maxSteps = 20): unknown {
  const response = callFlow({
    op: "workflow",
    mode: "autoflow",
    id: issueId,
    limit: maxSteps,
  });
  if (!response.ok) {
    throw new Error(`Flow autoflow failed: ${response.error?.message}`);
  }
  return response.result;
}

/**
 * Example: Validate config
 */
function validateConfig(): unknown {
  const response = callFlow({ op: "config", mode: "validate" });
  if (!response.ok) {
    throw new Error(`Flow config validation failed: ${response.error?.message}`);
  }
  return response.result;
}

/**
 * Example: Bootstrap a new Flow project
 */
function bootstrap(storage: "user" | "repo-tracked" | "repo-untracked" = "repo-tracked"): unknown {
  const response = callFlow({ op: "bootstrap", storage });
  if (!response.ok) {
    throw new Error(`Flow bootstrap failed: ${response.error?.message}`);
  }
  return response.result;
}

// =============================================================================
// Usage Examples
// =============================================================================

// Uncomment to run examples:

// // Get manifest
// getManifest();

// // Get workflow-specific manifest
// getWorkflowManifest();

// // Read state
// const state = getState();
// console.log("State:", state);

// // Inspect queue
// const queue = inspectQueue(5);
// console.log("Queue:", queue);

// // Create an issue
// const newIssue = createIssue("Fix login bug", "Users cannot login with SSO");
// console.log("Created:", newIssue);

// // Record a result
// const result = recordResult("FLOW-123", "main", "Fixed the bug", ["npm test"]);
// console.log("Result:", result);

// // Run autoflow
// const autoflow = autoFlow("FLOW-123", 10);
// console.log("Autoflow:", autoflow);

export {
  callFlow,
  getManifest,
  getWorkflowManifest,
  getState,
  inspectQueue,
  viewIssue,
  createIssue,
  recordResult,
  autoFlow,
  validateConfig,
  bootstrap,
  type FlowResponse,
};
