# Host Integration

Flow is embedded by agents and adapters. Humans use the dashboard.

Durable config belongs in `.flow/config.yaml`:

- repo topology
- provider selection
- ledger settings
- dashboard settings

Do not use environment variables as the source of truth for durable workflow
behavior.

Flow records agent handoff and result state. It does not choose, launch, retry,
or supervise agents.

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
