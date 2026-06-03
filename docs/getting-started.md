# Getting Started

Flow is workflow state for coding agents. It keeps issue routing, prepared
workspaces, handoff prompts, evidence, documentation disposition, pull request
state, and closeout readiness in one durable project model.

## Prerequisites

- Node.js 22 or 24
- npm 10 or newer
- Git
- `gh` when using GitHub issues or pull requests

## Install

```bash
npm install @camden-lowrance/flow
```

The package provides two command surfaces:

- `flow`: JSON-only protocol for agents, adapters, and automation.
- `flow-dashboard`: desktop/dashboard server for the human project view.

Start the dashboard:

```bash
npx flow-dashboard
```

Open `http://127.0.0.1:8767/dashboard`.

## Bootstrap

Flow durable behavior belongs in `.flow/config.yaml`.

```bash
flow '{"op":"bootstrap"}'
flow '{"op":"config","mode":"validate"}'
flow '{"op":"config","mode":"explain"}'
```

The bootstrap command creates a starter config from repository metadata. Edit
that file for topology, providers, runtime store, experimental app-layer
Autoflow, and dashboard settings. Do not use environment variables as the
primary topology or provider selection surface.

## First Workflow

All `flow` commands accept exactly one JSON request from argv or stdin and write
one JSON response to stdout.

```bash
flow '{"op":"manifest"}'
flow '{"op":"queue","limit":10}'
flow '{"op":"issue","mode":"view","id":"GH-123"}'
flow '{"op":"workflow","mode":"doctor","id":"GH-123"}'
```

Prepare and hand off work:

```bash
flow '{"op":"issue","mode":"select","id":"GH-123"}'
flow '{"op":"workflow","mode":"advance","id":"GH-123"}'
```

When `advance` asks for confirmation, approve it with the returned
`approveConfirmationId`.

Record completion evidence:

```bash
flow '{"op":"workflow","mode":"recordResult","id":"GH-123","repoKey":"flow","summary":"Implemented the change.","changedFiles":["src/example.ts"],"testsRun":["npm test"]}'
flow '{"op":"workflow","mode":"recordEvidence","id":"GH-123","summary":"npm test passed","criteria":["tests"]}'
flow '{"op":"workflow","mode":"recordDocumentation","id":"GH-123","disposition":"not_needed","summary":"No docs update required."}'
```

## Autoflow

Autoflow is experimental app-layer behavior built above the same Flow runtime
model. Core agent work should use the JSON issue and workflow commands above,
including `workflow adoptHandoff` for live local agent threads.

```bash
flow '{"op":"autoflow","mode":"status"}'
flow '{"op":"autoflow","mode":"run","id":"GH-123"}'
```

Select the agent session provider in durable config:

```yaml
runtime:
  agentSession:
    provider: "claude"
```

## More

- [Configuration Reference](config-reference.md)
- [CLI Reference](cli-reference.md)
- [Adapter Authoring](adapter-authoring.md)
- [Desktop Notes](desktop.md)
- [Troubleshooting](troubleshooting.md)
