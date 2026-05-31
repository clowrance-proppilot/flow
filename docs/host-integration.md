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
  type: "sql"
  dialect: "sqlite"
```

Provider-backed config should swap `issueTracker`, `collaboration`, and
`sourceControl` to adapters. Secrets may come from environment variables when an
adapter requires them.
