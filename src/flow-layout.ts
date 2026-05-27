import { createHash } from "node:crypto";
import { homedir, platform } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export const flowLayout = {
  config: ".flow/config.yaml",
  userState: platform() === "darwin"
    ? "Library/Application Support/Flow/projects"
    : ".local/state/flow/projects",
  managed: {
    runtime: ".flow/runtime",
    sessions: ".flow/runtime/sessions",
    ledger: ".flow/ledger/workflow.jsonl",
    issueProjections: ".flow/ledger/issues/<issueRef>.json",
    contextProjection: ".flow/ledger/context.json",
  },
} as const;

export function flowConfigPath(projectRoot: string): string {
  return join(resolve(projectRoot), flowLayout.config);
}

export function flowUserStateRoot(projectRoot: string): string {
  const root = resolve(projectRoot);
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(homedir(), flowLayout.userState, `${basename(root)}-${digest}`);
}

export function flowUserConfigPath(projectRoot: string): string {
  return join(flowUserStateRoot(projectRoot), "config.yaml");
}

export function flowRuntimePath(projectRoot: string): string {
  return join(resolve(projectRoot), flowLayout.managed.runtime);
}

export function flowUserRuntimePath(projectRoot: string): string {
  return join(flowUserStateRoot(projectRoot), "runtime");
}

export function flowWorkflowLedgerPath(projectRoot: string): string {
  return join(resolve(projectRoot), flowLayout.managed.ledger);
}

export function flowUserWorkflowLedgerPath(projectRoot: string): string {
  return join(flowUserStateRoot(projectRoot), "ledger", "workflow.jsonl");
}

export function flowIssueProjectionPath(projectRoot: string, issueRef: string): string {
  return join(resolve(projectRoot), ".flow", "ledger", "issues", `${flowIssueProjectionFileName(issueRef)}.json`);
}

export function flowUserIssueProjectionPath(projectRoot: string, issueRef: string): string {
  return join(flowUserStateRoot(projectRoot), "ledger", "issues", `${flowIssueProjectionFileName(issueRef)}.json`);
}

export function flowContextProjectionPath(projectRoot: string): string {
  return join(resolve(projectRoot), ".flow", "ledger", "context.json");
}

export function flowUserContextProjectionPath(projectRoot: string): string {
  return join(flowUserStateRoot(projectRoot), "ledger", "context.json");
}

export function flowIssueProjectionFileName(issueRef: string): string {
  return issueRef.replace(/[^a-zA-Z0-9._-]/g, "_") || "issue";
}

export function resolveFlowPath(projectRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(projectRoot, path);
}
