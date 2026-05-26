# Flow

Flow is workflow state for coding agents.

Agents and adapters use its JSON contract for issue state, handoff, evidence,
readiness, and closeout. Humans use the dashboard.

Flow does not replace the IDE, issue tracker, Git, PRs, CI, or agent runtime.
It records handoff and results; it does not run agents.

## Install

```bash
npm install @camden-lowrance/flow
npx flow-dashboard
```

Package: [@camden-lowrance/flow](https://www.npmjs.com/package/@camden-lowrance/flow)

## Surfaces

- `flow-dashboard`: human view.
- `flow`: JSON protocol for agents and adapters.

## Agent Contract

- `flow` accepts one JSON body.
- `flow` writes one JSON document to stdout.
- `.flow/config.yaml` owns durable topology, adapters, dashboard, and ledger
  settings.
- Flow writes runtime state and the workflow ledger.

Examples:

```bash
flow --help
flow '{"op":"bootstrap"}'
flow '{"op":"queue"}'
flow '{"op":"manifest","target":"workflow"}'
flow '{"op":"workflow","mode":"recordEvidence","id":"FLOW-123","summary":"npm test passed","criteria":["tests"]}'
```

`flow --help`, `flow`, and `flow manifest` all return the compact JSON manifest.

## Files

```text
.flow/config.yaml
.flow/runtime/
.flow/ledger/workflow.jsonl
.flow/ledger/issues/
```

Environment variables are only for process context, local launch mechanics, and
secret injection. Durable behavior belongs in `.flow/config.yaml`.

## Release Checks

```bash
npm run check
npm test
npm run build
npm run readiness:public
```

More:

- [Host integration](docs/host-integration.md)
- [Runtime and dashboard](docs/runtime-and-dashboard.md)
- [Why Flow](docs/why-flow.md)
