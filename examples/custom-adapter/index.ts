/**
 * Custom Adapter Integration Example
 *
 * Shows how to programmatically create a Flow runtime with custom adapters.
 */

import { createConfiguredWorkRuntime, type FlowConfig } from "../../src/index.js";
import { LinearIssueTrackerAdapter } from "./linear-issue-tracker.js";
import { GitLabCollaborationAdapter } from "./gitlab-collaboration.js";

/**
 * Example: Create a Flow runtime with custom adapters
 */
export function createCustomAdapterRuntime(projectRoot: string) {
  // Create adapter instances
  const issueTracker = new LinearIssueTrackerAdapter({
    apiKey: process.env.LINEAR_API_KEY ?? "",
    teamId: process.env.LINEAR_TEAM_ID ?? "",
  });

  const collaboration = new GitLabCollaborationAdapter({
    baseUrl: "https://gitlab.com",
    token: process.env.GITLAB_TOKEN ?? "",
  });

  // Or use the config-based approach:
  const flowConfig: FlowConfig = {
    version: "1",
    project: {
      name: "my-project",
    },
    topology: {
      repos: {
        main: {
          name: "my-project",
          baseBranch: "main",
        },
      },
      branchPattern: "{kind}/{issueRef}-{slug}",
    },
    issueTracker: {
      type: "linear",
      apiKey: process.env.LINEAR_API_KEY,
      teamId: process.env.LINEAR_TEAM_ID,
    },
    collaboration: {
      type: "gitlab",
      baseUrl: "https://gitlab.com",
      token: process.env.GITLAB_TOKEN,
    },
    sourceControl: {
      type: "git",
    },
    ledger: {
      type: "flow",
    },
  };

  // Create runtime with config
  const configured = createConfiguredWorkRuntime({
    projectRoot,
    flowConfig,
  });

  return configured;
}

/**
 * Example: Using the runtime
 */
async function main() {
  const projectRoot = process.cwd();
  const { runtime, issueTracker, collaboration } = createCustomAdapterRuntime(projectRoot);

  // Fetch active issues from Linear
  const activeIssues = await issueTracker.fetchActiveQueue?.(10);
  console.log("Active issues:", activeIssues);

  // Find open merge requests from GitLab
  const mergeRequests = await collaboration.findCodeReviews("my-project");
  console.log("Merge requests:", mergeRequests);

  // Use the Flow runtime for workflow operations
  const manifest = await runtime.execute({
    op: "manifest",
    target: "workflow",
  });
  console.log("Manifest:", manifest);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
