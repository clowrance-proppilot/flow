# Custom Adapter Example

This example demonstrates how to create custom adapters for Flow's provider system.

## Overview

Flow uses three adapter interfaces to integrate with external systems:

1. **IssueTrackerProvider** - Manages issues (GitHub Issues, Jira, Linear, etc.)
2. **CodeCollaborationProvider** - Handles code reviews (GitHub PRs, GitLab MRs, etc.)
3. **SourceControlProvider** - Manages workspace operations (Git, Mercurial, etc.)

## Files

- `linear-issue-tracker.ts` - Example: Linear issue tracker adapter
- `gitlab-collaboration.ts` - Example: GitLab merge request adapter
- `sample-config.yaml` - Example Flow configuration using custom adapters
- `index.ts` - Entry point showing how to wire adapters together

## Creating a Custom Adapter

### 1. Implement the Interface

Choose which provider interface to implement:

```typescript
import type { IssueTrackerProvider } from "@camden-lowrance/flow";

export class MyCustomIssueTracker implements IssueTrackerProvider {
  readonly capabilities = {
    canCreateIssues: true,
    canTransitionIssues: true,
    canPostComments: true,
    canManageActivePlanningLane: false,
  };

  async getIssue(ref: string): Promise<UnifiedIssue> {
    // Fetch issue from your system
    // Return normalized UnifiedIssue
  }

  async fetchActiveQueue(limit?: number): Promise<UnifiedIssue[]> {
    // Return active issues
  }

  // ... implement other required methods
}
```

### 2. Normalize to Unified Types

All adapters must return Flow's unified types:

- `UnifiedIssue` - Normalized issue representation
- `UnifiedCodeReview` - Normalized code review representation
- `UnifiedWorkspaceStatus` - Normalized workspace state

### 3. Handle Errors

Use `ProviderAdapterError` for consistent error handling:

```typescript
import { ProviderAdapterError } from "@camden-lowrance/flow";

throw new ProviderAdapterError({
  provider: "my-provider",
  operation: "getIssue",
  code: "provider_failed",
  message: "Failed to fetch issue",
  cause: originalError,
});
```

### 4. Configure in Flow

Add your adapter to `.flow/config.yaml`:

```yaml
issueTracker:
  type: "my-custom-tracker"
  apiKey: "${MY_API_KEY}"  # Use env vars for secrets
  workspace: "my-workspace"
```

## Running the Example

```bash
# Install dependencies
npm install

# Run with custom adapter
npx flow --config ./sample-config.yaml '{"op":"queue"}'
```

## Testing Your Adapter

```typescript
import { describe, it, expect } from "vitest";
import { MyCustomIssueTracker } from "./my-adapter";

describe("MyCustomIssueTracker", () => {
  it("fetches issues", async () => {
    const adapter = new MyCustomIssueTracker({ apiKey: "test" });
    const issue = await adapter.getIssue("ISSUE-123");
    expect(issue.ref).toBe("ISSUE-123");
    expect(issue.title).toBeDefined();
  });
});
```
