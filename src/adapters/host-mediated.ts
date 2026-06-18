import type { IssueTrackerCapabilities, IssueTrackerProvider, UnifiedIssue } from "./provider-contracts.js";

/**
 * Host-mediated issue tracker adapter.
 *
 * Flow does not perform provider I/O in this mode — the agent calls the bound
 * provider's MCP (resolved via the `flow_delegate` tool) and reports results
 * back through flow_record_* tools. This adapter therefore advertises no
 * direct capabilities and returns empty queues; direct fetches are redirected
 * to the host-mediated path.
 */
export class HostMediatedIssueTrackerAdapter implements IssueTrackerProvider {
  readonly capabilities: IssueTrackerCapabilities = {
    canCreateIssues: false,
    canTransitionIssues: false,
    canPostComments: false,
    canManageActivePlanningLane: false,
    canFetchOpenIssues: false,
    canSearchIssues: false,
    canTagIssues: false,
  };

  constructor(private readonly binding: string) {}

  async getIssue(ref: string): Promise<UnifiedIssue> {
    throw new Error(
      `Issue "${ref}" is host-mediated via "${this.binding}". Flow does not fetch it directly — call flow_delegate(operation: "view", ref: "${ref}") to get the tool call, run it through the ${this.binding} MCP, then report the result back with flow_record_* tools.`,
    );
  }

  async fetchActiveQueue(): Promise<UnifiedIssue[]> {
    return [];
  }

  async fetchBacklogQueue(): Promise<UnifiedIssue[]> {
    return [];
  }

  async fetchOpenIssues(): Promise<UnifiedIssue[]> {
    return [];
  }
}
