# Runtime And Dashboard

Flow has two surfaces:

- `flow-dashboard`: read-only human mirror.
- `flow`: JSON protocol for agents and adapters.

The dashboard reads Flow state through `/api/dashboard`. It does not expose
workflow command routes, action endpoints, or agent orchestration controls.
Dashboard reloads only re-read that state snapshot.

## Dashboard

```bash
npx flow-dashboard
```

Default endpoints:

- `http://127.0.0.1:8767/dashboard`
- `http://127.0.0.1:8767/api/dashboard`
- `http://127.0.0.1:8767/healthz`

Dashboard presentation is built in. It does not load project custom CSS or expose
theme controls.

## Agent Protocol

```bash
flow --help
flow '{"op":"queue"}'
flow '{"op":"manifest","target":"workflow"}'
flow '{"op":"workflow","mode":"recordResult","id":"FLOW-123","repoKey":"main","summary":"Patch applied","testsRun":["npm test"]}'
```

Work-item requests use `id` as the public identifier.

Stdout is always one JSON document.

## Handoff Prompts

When work cannot continue in the current thread, Flow records a handoff prompt.
It does not launch or supervise another agent. The prompt is the pickup note for
the next local thread, and the result is recorded back through `flow`.
