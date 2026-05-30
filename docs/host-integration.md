# Host Integration

Flow is embedded by agents and adapters. Humans use the read-only dashboard
mirror.

Durable config belongs in `.flow/config.yaml`:

- repo topology
- provider selection
- ledger settings
- dashboard settings

Do not use environment variables as the source of truth for durable workflow
behavior.

Flow records handoff prompts and result state. It does not choose, launch,
retry, or supervise agents. A handoff prompt is a copy-ready pickup note for the
next local agent thread.

Minimal local config:

```yaml
version: "1"
project:
  name: "local-flow"
topology:
  repos:
    main:
      name: "local-flow"
issueTracker:
  type: "local"
  prefix: "FLOW"
collaboration:
  type: "none"
sourceControl:
  type: "git"
ledger:
  type: "flow"
```

Provider-backed config should swap `issueTracker`, `collaboration`, and
`sourceControl` to adapters. Secrets may come from environment variables when an
adapter requires them.

## Custom Adapters

Flow supports custom adapters for integrating with any issue tracker, code
collaboration platform, or source control system.

Adapter interfaces:

- `IssueTrackerProvider` - Manages issues (GitHub Issues, Jira, Linear, etc.)
- `CodeCollaborationProvider` - Handles code reviews (GitHub PRs, GitLab MRs, etc.)
- `SourceControlProvider` - Manages workspace operations (Git, Mercurial, etc.)

See the [custom adapter example](../examples/custom-adapter/README.md) for a
complete implementation guide with Linear and GitLab examples.
