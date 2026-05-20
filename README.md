# Flow

Flow is a durable coordination and workflow orchestration engine for
agent-assisted developer work. Projects bring a `flow.config.yaml`; Flow brings
the runtime, workflow ledger, reconciliation, readiness checks, executor tracking,
CLI, and operator dashboard.

Flow is a standalone package that can be plugged into multiple host repos. The
consuming architecture owns its `flow.config.yaml`; Flow owns the reusable
runtime. See [Host Repo Integration](docs/host-integration.md).

## Runtime Shape

- **CLI** is the only blessed operator write/control surface and emits stable
  JSON.
- **Work Runtime** is the in-process library behind the CLI. It validates work,
  reconciles Jira/Git/GitHub/ledger state, runs readiness checks, and records
  lifecycle state.
- **Executors** are execution modes: local live agent thread or hands-off
  background run.
- **Ledger** stores durable work envelopes, events, executor progress, results,
  evidence, and handoff state.

## Local Checks

From the Flow repo:

```bash
npm run check
npm test
npm run start:all:watch
```

## Host Repo Integration

Use the checked-in example as a starting shape for the host repo's
`flow.config.yaml`:

```text
examples/flow.config.yaml
```

With a sibling checkout:

```bash
FLOW_PROJECT_ROOT=/path/to/host-repo /path/to/flow/bin/flow queue
```

With Flow installed as a host repo dependency:

```bash
npm install --save-dev ../flow
npx flow queue
npx flow-dashboard
```

## Run Flow Against A Project

Run Flow from the project repository that contains `flow.config.yaml`:

```bash
FLOW_PROJECT_ROOT=/path/to/project /path/to/flow/bin/flow queue
```

If `FLOW_PROJECT_ROOT` is omitted, Flow uses the current working directory as
the project root.

```bash
cd /path/to/project
/path/to/flow/bin/flow queue
```

Common commands:

```text
flow commands
flow queue
flow create-issue --type Bug --summary "Fix provider parquet schema" --description "Follow-up from ISSUE-15461." --repo app_api
flow select ISSUE-123 --session codex-issue-123
flow advance ISSUE-123 --session codex-issue-123
flow autoflow ISSUE-123 --session codex-issue-123
```

`flow commands` emits the supported operator commands, descriptions, examples,
and the raw Work Runtime methods available through `flow call`. Prefer the
first-class commands for normal work; use `flow call` when you need a lower-level
runtime method such as `createIssue` or `routeIssue`.

## State

Durable state lives outside Pi chat history under:

```text
.context/flow/
```

The CLI path owns workflow decisions through Work Runtime. The native Flow JSONL
ledger is the default durable workflow store; legacy adapters can be enabled
explicitly.

## Contracts

Typed contracts live under `src/contracts/`:

- `work.ts` for work envelopes, work jobs, issue state, and execution modes.
- `executor.ts` for executor request/result/progress records.
- `runtime.ts` for runtime session, event, and readiness records.
- `evidence.ts` for acceptance, review, escalation, investigation, and docs records.
- `common.ts` for shared helpers and cross-cutting enums.

`src/contracts.ts` is only a compatibility barrel; new schemas should go in the
focused contract modules.
