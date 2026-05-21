import { join, resolve } from "node:path";

export const flowLayout = {
  config: ".flow/config.yaml",
  managed: {
    runtime: ".flow/runtime",
    sessions: ".flow/runtime/sessions",
    ledger: ".flow/ledger/workflow.jsonl",
    issueProjections: ".flow/ledger/issues/<issueRef>.json",
  },
} as const;

export function flowConfigPath(projectRoot: string): string {
  return join(resolve(projectRoot), flowLayout.config);
}

export function flowRuntimePath(projectRoot: string): string {
  return join(resolve(projectRoot), flowLayout.managed.runtime);
}

export function flowWorkflowLedgerPath(projectRoot: string): string {
  return join(resolve(projectRoot), flowLayout.managed.ledger);
}

export function flowIssueProjectionPath(projectRoot: string, issueRef: string): string {
  return join(resolve(projectRoot), ".flow", "ledger", "issues", `${flowIssueProjectionFileName(issueRef)}.json`);
}

export function flowIssueProjectionFileName(issueRef: string): string {
  return issueRef.replace(/[^a-zA-Z0-9._-]/g, "_") || "issue";
}
