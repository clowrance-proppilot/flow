# Runtime And Dashboard

Flow has two surfaces:

- `flow-dashboard`: human view.
- `flow`: JSON protocol for agents and adapters.

Dashboard actions route through the same runtime path as agents.

## Dashboard

```bash
npx flow-dashboard
```

Default endpoints:

- `http://127.0.0.1:8767/dashboard`
- `http://127.0.0.1:8767/api/dashboard`
- `http://127.0.0.1:8767/healthz`

Dashboard CSS defaults to `.flow/dashboard.css`. Assets beside that CSS file are
served from `/dashboard/custom-assets/`.

## Agent Protocol

```bash
flow --help
flow '{"op":"queue"}'
flow '{"op":"manifest","target":"workflow"}'
flow '{"op":"workflow","mode":"recordResult","id":"FLOW-123","repoKey":"main","summary":"Patch applied","testsRun":["npm test"]}'
```

Work-item requests use `id` as the public identifier.

Stdout is always one JSON document.
