# Flow

Flow is a durable coordination and workflow orchestration engine for
agent-assisted developer work. Projects bring a `flow.config.yaml`; Flow brings
the runtime, event ledger, reconciliation, readiness checks, executor tracking,
CLI, and operator dashboard.

## Runtime Shape

- **CLI** is the operator surface and emits stable JSON.
- **Work Runtime** validates work, reconciles Jira/Git/GitHub/Beads, runs
  readiness checks, and records lifecycle state.
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
flow queue
flow select FSB-123 --session codex-fsb-123
flow advance FSB-123 --session codex-fsb-123
flow autoflow FSB-123 --session codex-fsb-123
```

## State

Durable state lives outside Pi chat history under:

```text
.context/flow/
```

Work Runtime owns workflow decisions. The native Flow JSONL ledger is the
default durable workflow store; legacy adapters can be enabled explicitly.

## Contracts

Typed contracts live under `src/contracts/`:

- `work.ts` for work envelopes, work jobs, issue state, and execution modes.
- `executor.ts` for executor request/result/progress records.
- `runtime.ts` for runtime session, event, and readiness records.
- `evidence.ts` for acceptance, review, escalation, investigation, and docs records.
- `common.ts` for shared helpers and cross-cutting enums.

`src/contracts.ts` is only a compatibility barrel; new schemas should go in the
focused contract modules.
