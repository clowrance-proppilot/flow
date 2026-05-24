# Flow

Flow is a durable workflow authority for agent-assisted developer work. It is
not an agent orchestrator, IDE, ticket tracker, or CI replacement. Projects
bring a `.flow/config.yaml`; Flow brings the runtime, workflow ledger,
reconciliation, readiness checks, executor tracking, CLI, and operator
dashboard.

Flow is a standalone package that can be plugged into multiple host repos. The
consuming architecture owns its `.flow/config.yaml`; Flow owns the reusable
runtime and exposes optional plugin surfaces for agent SDKs, executors, and
provider adapters. See [Host Repo Integration](docs/host-integration.md).

For positioning, alternatives, and the short demo narrative, see
[Why Flow](docs/why-flow.md).

## Runtime Shape

- **CLI** is the only blessed operator write/control surface and emits stable
  JSON.
- **Work Runtime** is the in-process library behind the CLI. It validates work,
  reconciles issue tracker, Git, code review, and ledger state, runs readiness
  checks, and records lifecycle state.
- **Executors** are pluggable execution modes: local live agent thread,
  background CLI, agent SDK, or host-provided adapter.
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

Let Flow create the initial host repo config from the current folder and Git
metadata:

```bash
cd /path/to/host-repo
/path/to/flow/bin/flow '{"op":"bootstrap"}'
```

By default this writes per-user Flow state outside the repo. Use
`flow '{"op":"bootstrap","storage":"repo-untracked"}'` to keep `.flow/` in the
checkout and hide it through `.git/info/exclude`, or `repo-tracked` when the repo
is ready to share `.flow/config.yaml`.

Or use the checked-in example as a starting shape for a shared host repo
`.flow/config.yaml`:

```text
examples/.flow/config.yaml
```

With a sibling checkout:

```bash
cd /path/to/host-repo
/path/to/flow/bin/flow '{"op":"queue"}'
```

With Flow installed as a host repo dependency after package publication:

```bash
npm install --save-dev @camden-lowrance/flow
npx flow '{"op":"queue"}'
npx flow-dashboard
```

## Run Flow Against A Project

Run Flow from the project repository that contains `.flow/config.yaml`:

```bash
cd /path/to/project
/path/to/flow/bin/flow '{"op":"queue"}'
```

Agent surface:

```text
flow manifest
flow
flow '{"op":"manifest","target":"workflow"}'
flow '{"op":"bootstrap"}'
flow '{"op":"queue"}'
flow '{"op":"issue","mode":"create","issueType":"Bug","summary":"Fix provider parquet schema","description":"Follow-up from ISSUE-15461.","repoKeys":["app_api"]}'
flow '{"op":"issue","mode":"adoptBranch","summary":"Spike provider parquet schema","repoKey":"app_api"}'
flow '{"op":"issue","mode":"select","issueRef":"ISSUE-123","sessionId":"codex-issue-123"}'
flow '{"op":"workflow","mode":"advance","issueRef":"ISSUE-123","sessionId":"codex-issue-123"}'
flow '{"op":"workflow","mode":"autoflow","issueRef":"ISSUE-123","sessionId":"codex-issue-123"}'
flow '{"op":"workflow","mode":"recordResult","issueRef":"ISSUE-123","sessionId":"codex-issue-123","repoKey":"app_api","summary":"Patch applied and focused tests passed","changedFiles":["src/example.ts"],"testsRun":["npm test"]}'
```

`flow` with no input and `flow manifest` emit a compact capability index only.
Detailed examples and accepted modes are opt-in by target, such as
`{"op":"manifest","target":"workflow"}`. This keeps agent discovery from
turning into a large MCP-style context dump.

Use `{"op":"workflow","mode":"recordResult"}` when the current local thread or
an external execution adapter has already done the work. Flow claims the pending
handoff if one exists, records the structured result, and continues lifecycle
reconciliation without trying to manage the runtime that performed the work.

Optional execution adapter settings belong in `.flow/config.yaml` under the
compatibility key `runtime.worker`. Treat `.flow/config.yaml` like
Kubernetes-style declarative configuration: it owns durable workflow behavior.
Environment variables may still be used for process context, local launch
mechanics, or secret injection where an adapter requires them, but they should
not define workflow topology or policy.

Flow no longer spawns or manages workers from Work Runtime.
`flow '{"op":"workflow","mode":"advance"}'` and
`flow '{"op":"workflow","mode":"autoflow"}'` stop at an execution handoff with
enough Flow context for an external worker, live thread, or host adapter to do
the work. That runtime later reports back through
`flow '{"op":"workflow","mode":"recordResult",...}'`.

Most projects only need topology, issue tracker, collaboration, source control,
and ledger config. Flow has permissive built-in defaults for work types,
executors, execution timeouts, session naming, and dashboard host/port. The
default workflow is designed to guide the live agent thread through Flow with
minimal capability gating. Configure `workTypes` or `executors` only when a host
needs to replace the default workflow categories or result contract.

For a bare local setup with no hosted issue tracker or code review provider, use
Flow's local issue adapter and disable collaboration:

```yaml
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

`issueTracker.type: local` means issues are created from the CLI and persisted
through Flow's ledger. `ledger.type: flow` means the native append-only workflow
ledger remains the durable state backend.

For spike work that should stay out of hosted trackers, use
`flow '{"op":"issue","mode":"adoptBranch",...}'`. It records the current
branch/worktree as local Flow work and marks hosted issue and code review
projections as unpublished until a later checkpoint promotes them.

## State

Durable state lives outside agent chat history under:

```text
.flow/
  config.yaml
  runtime/
    sessions/
  ledger/
    workflow.jsonl
    issues/
      ISSUE-123.json
```

The host repo owns the human-authored `.flow/config.yaml`. Flow manages the rest
of `.flow/`: runtime sessions, the append-only JSONL audit log at
`.flow/ledger/workflow.jsonl`, and per-issue projections under
`.flow/ledger/issues/` for fast issue-level reads. The CLI path owns workflow
decisions through Work Runtime; legacy adapters can be enabled explicitly.

`.flow/runtime` is session-local scratch state for CLI selection, pending
confirmations, and transient runtime traces. It is not a second workflow ledger.
Durable issue, execution result, job, evidence, and handoff state belongs in
`.flow/ledger/workflow.jsonl` and its generated issue projections.

## Contracts

Typed contracts live under `src/contracts/`:

- `work.ts` for work envelopes, work jobs, issue state, and execution modes.
- `executor.ts` for executor request/result/progress records.
- `runtime.ts` for runtime session, event, and readiness records.
- `evidence.ts` for acceptance, review, escalation, investigation, and docs records.
- `common.ts` for shared helpers and cross-cutting enums.

`src/contracts.ts` is only a compatibility barrel; new schemas should go in the
focused contract modules.
