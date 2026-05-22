# Flow Runtime And Dashboard

Flow is optional local workflow infrastructure for repo-hosted
agent-assisted work. It is not part of any product application runtime and is not
required for manual development.

Use it when an operator-facing agent needs durable workflow coordination across
an issue tracker, Git, code review, local worktrees, executor attempts,
acceptance evidence, and PR handoff. Skip it for ordinary manual edits,
component build/test loops, or explicit direct-tooling recovery.

## Runtime Roles

The active local stack has one long-running role plus the CLI:

- **Readiness checks** evaluates Work Runtime-reconciled state and returns blockers or
  readiness.
- **Work Runtime** is the workflow authority. It reconciles issue tracker,
  Git/worktree, code review, executor output, and ledger state before deciding
  the next valid action.
- **CLI** is the operator surface used by local coding agents.
  It emits stable JSON and persists Work Runtime sessions.
- **Dashboard** is the browser operator console. It presents CLI-reconciled Flow
  state and routes any dashboard actions back through `flow call`.

Executors are assigned per issue. An executor may be the current live agent
thread adopted by Work Runtime, a bundled background executor, or a host/plugin
adapter launched for a narrow task. Executors are not long-running services.
Flow treats concrete SDKs, CLIs, and model providers as adapters behind the
executor contract, not as workflow policy.

The live agent thread is the normal interactive work surface for complex sprint
issues. One live thread can coordinate multiple issue-tracker efforts, but each effort
keeps separate Flow state: issue, routed repos, worktrees, evidence, PR
state, blockers, and closeout. Chat history is not the workflow ledger.

`.flow/runtime` stores session-local CLI/runtime scratch state only. Treat
`.flow/ledger/workflow.jsonl` as the durable workflow ledger and
`.flow/ledger/issues/*.json` as generated projections that can be rebuilt from
the ledger.

## Communication Protocol

Operator-facing agents talk to the CLI for workflow actions. The CLI is the
protocol boundary that turns JSON command input into Work Runtime-owned workflow
calls. This keeps issue tracker, code review, ledger, native Flow writes,
readiness gates, evidence, PR handoff, approval closeout, and post-merge
verification in one authority path.

```mermaid
flowchart LR
  Live["Live agent thread"]
  CLI["CLI: JSON command surface"]
  Coord["Work Runtime: workflow authority"]
  Gate["Readiness checks: readiness"]
  Executor["Background Executor: optional"]
  Systems["Issue tracker / code review / ledger"]
  Tree["Prepared worktree"]

  Live --> CLI
  CLI --> Coord
  Coord --> Gate
  Coord <--> Systems
  Coord --> Tree
  Coord --> Executor
  CLI --> Live
  Live --> Tree
  Executor --> Tree
  Executor --> CLI
  CLI --> Dashboard["Dashboard: browser console"]
```

Dashboard is a separate operator console over CLI-reconciled state. It does not
own issue tracker, code review, ledger, branch, PR, work envelope, or executor decisions.

## Start Commands

From the Flow repo:

```bash
npm run start:all
npm run start:all:watch
npm run flow
npm run dashboard
```

From the repo root:

```bash
flow commands
flow manifest
flow queue
flow create-issue --type Bug --summary "Fix provider parquet schema" --description "Follow-up from ISSUE-15461." --repo app_api
flow select ISSUE-123 --session codex-issue-123
flow advance ISSUE-123 --session codex-issue-123
flow-dashboard
```

`flow manifest` is the CLI discovery contract. It returns JSON derived from the
registered Commander commands, including command descriptions, arguments,
options, defaults, required flags, negated flags, and the raw Work Runtime
methods supported by `flow call`, including `createIssue`,
`bootstrapJiraIssue`, `routeIssue`, and `advanceIssue`. `flow commands` returns
a compact compatibility view plus the same manifest. Provider-specific method
names remain only as compatibility aliases where existing agents already use
them.

`npm run start:all` starts the Dashboard. It also builds the runtime and
dashboard first.

You do not need to launch a Flow server for workflow. The CLI loads Work Runtime
directly and exits after emitting JSON. Launch the dashboard server only when you
want the browser operator console.

`npm run start:all:watch` wraps `start:all` with Node watch mode for `src/` and
`flow/`. Use it while editing Flow runtime code so file changes rebuild
and restart the local stack automatically.

`start:all` prints the dashboard URL but does not open a browser by default.

Use `--session <id>` to persist CLI sessions under
`.flow/runtime/sessions/`.

## Endpoints

Dashboard:

- UI: `http://127.0.0.1:8767/dashboard`
- API: `http://127.0.0.1:8767/api/dashboard`
- Health: `http://127.0.0.1:8767/healthz`

Work Runtime is an in-process library used by the CLI. Dashboard actions route
through the same CLI path instead of a separate Work Runtime API.

## Dashboard Refresh Semantics

The dashboard serves live CLI-reconciled Flow state. It does not cache queue data or
serve stale snapshots.

- Browser poll interval: 5 seconds
- Every `/api/dashboard` request performs a `flow call inspectDashboardQueue`
  inspection
- Manual Refresh performs the same live read immediately
- Live refresh timeout: 60 seconds

## Flow Ledger

Work Runtime writes to the native Flow JSONL workflow ledger by default:
the current bootstrap storage's ledger path. The default `flow bootstrap` keeps
that path in user state outside the repo; `--storage repo-tracked` uses
`.flow/ledger/workflow.jsonl`. Configure `runtime.workflowLedgerPath` to use a
different local ledger file.

Flow also maintains per-issue projection snapshots under
`.flow/ledger/issues/<issueRef>.json` so issue-level reads do not need to replay
the whole JSONL ledger. The JSONL file remains the authoritative audit log and
can rebuild missing projections.

Consumers using shared repo config should edit only `.flow/config.yaml`; Flow
manages runtime and ledger files.

Set `ledger.type: beads` in `.flow/config.yaml` only when intentionally running
the legacy Beads adapter.

The dashboard API includes snapshot freshness:

```json
{
  "snapshot": {
    "source": "flow_cli",
    "refreshedAt": "2026-05-13T20:43:18.114Z",
    "ageSeconds": 0,
    "stale": false
  },
  "stale": false,
  "refreshing": false,
  "degraded": false
}
```

The dashboard API does not return stale issue data. If the Flow CLI is unavailable
or times out, it returns `degraded=true` with the error and an empty issue list.

## Authority Boundary

Dashboard must not write issue tracker, code review, ledger, branch state, PR
state, work envelopes, or executor orchestration directly. The Flow CLI is the
only blessed workflow write/control surface; Work Runtime remains the
in-process library behind it.

If Dashboard and Flow disagree, use the Flow CLI to reconcile the
issue, then refresh Dashboard. Do not treat Dashboard card text as more
authoritative than CLI output, Readiness checks, provider state, or the
prepared worktree.

## Validation

Run the focused Flow checks from the Flow repo:

```bash
npm run build
npm run check
npm test
npm run smoke:dashboard
```

For dashboard-only changes, `npm run build` and `npm run smoke:dashboard` are
the minimum useful checks.

## Dashboard styling

The dashboard loads `/dashboard/custom.css` after the bundled stylesheet. By
default that endpoint serves `.flow/dashboard.css` from the host repo when the
file exists. Hosts can point at a different file with:

```yaml
runtime:
  dashboard:
    customCssPath: "ui/flow-dashboard.css"
```

Use that CSS file for broad visual customization: color variables, fonts, icon
stroke weight, and brand mark overrides. For example:

```css
:root {
  --th-primary: #0f766e;
  --th-primary-dark: #115e59;
  --th-primary-fg: #ffffff;
  --th-font-sans: Inter, system-ui, sans-serif;
  --th-font-mono: "JetBrains Mono", ui-monospace, monospace;
  --th-icon-stroke-width: 1.75;
}

.brand-mark-icon {
  display: none;
}

.brand-mark {
  --th-brand-icon-image: url("/dashboard/custom-assets/company-mark.svg");
}
```

Files beside the active custom CSS file are served under
`/dashboard/custom-assets/`, so a host can keep icons, font files, and other
dashboard-only assets next to its stylesheet.
