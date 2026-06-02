# Optional Hatchet Execution Plane Spike

## Decision

Hatchet can own durable Autoflow execution, but it is not the default Flow
runtime. Flow keeps workflow semantics and the stable JSON CLI remains the core
control surface.

This spike is a reference adapter. It should not make the default Flow install
or normal CLI workflow depend on Hatchet.

Flow should not make the CLI or desktop process the runner. Those surfaces should enqueue, pause, resume, inspect, and render status. A long-lived execution plane should own scheduling, retries, worker slots, concurrency, durable run state, and replay.

## Split

Hatchet owns:

- task scheduling
- durable run state
- retries and replay
- worker slots
- repo-level concurrency keys
- run logs and dashboard visibility

Flow owns:

- `.flow/config.yaml` topology
- issue and phase policy
- worktree and branch policy
- executor adapter selection
- evidence, documentation, PR, and closeout rules
- GitHub/Jira/provider adapters

The intended shape is:

```text
CLI/Desktop/API -> Flow control layer -> Hatchet task -> Flow runtime APIs -> executor adapters
```

## First Task Boundary

The first Hatchet task should be `flow.autoflow.run_issue`.

The task must stay thin. It should call one Flow-owned internal runner method
with a typed payload and return the result. It should not duplicate Doctor,
workspace, GitHub, evidence, PR, or closeout policy inside the Hatchet task.

Input should match `HatchetAutoflowPayload` in `src/execution-plane.ts`:

- `projectId`
- `issueRef`
- `repoKeys`
- `requestedBy`
- `runId`
- `reason`
- `concurrencyKey`

The task should call Flow runtime APIs in this order:

1. Select the issue.
2. Run Doctor.
3. Prepare the workspace.
4. Create the worker handoff.
5. Run the executor adapter.
6. Record the result.
7. Advance through closeout.

These steps are listed to show the Flow-owned semantics. They remain in Flow
internals through `AutoflowService.runExecutionPlanePayload`; Hatchet only
schedules and invokes that method through the task runner.

## Durable Pi Sessions

A durable Pi session should be a Flow-owned handle, not a Hatchet-owned
transcript. Hatchet should persist and pass only enough data to resume:

- `provider: "pi"`
- `issueRef`
- `flowSessionId`
- `piSessionId`
- `sessionFile`
- `workspacePath`

Flow should store the handle and session state in SQL or `.flow/runtime`.
Hatchet tasks can reopen the session by handle, post a prompt or follow-up,
wait for the result, then call Flow runtime APIs to record the worker result.

Steering should target the same durable session handle. Later, Hatchet can wait
on a steering/signal event, but Flow should remain the source of truth for the
session link and transcript projection.

## Concurrency

The first concurrency key is:

```text
flow:{projectId}:repos:{sortedRepoKeys}
```

This serializes repo/worktree mutation for the same project and repo set. It is intentionally conservative. Once the repo lock model is explicit, independent repos can run in parallel.

## CLI And Desktop

The CLI remains JSON-only. It should call the Flow control layer and return a single JSON document. It should not own run loops, retries, or active worker state.

Desktop can stay as a Flow-specific UI for queue, issue detail, chat/session steering, and local project controls. Hatchet's dashboard can handle execution logs, retries, replay, and worker state.

## Optional Spike Surface

The first implementation pass added a Hatchet provider behind
`AutoflowExecutionProvider`, but it stays optional:

- enable `runtime.executionPlane.type: "hatchet"` from durable config
- install and connect to Hatchet with `@hatchet-dev/typescript-sdk`
- register `flow.autoflow.run_issue` through `createHatchetAutoflowTask`
- enqueue targeted issue runs through `HatchetAutoflowExecutionProvider`
- map Hatchet run status into Flow Autoflow status
- keep local execution behind existing executor adapters

The code seam is in `src/hatchet-execution.ts`. Normal Flow tests use a fake
Hatchet client. The default package does not require the Hatchet SDK or a
running Hatchet server.
