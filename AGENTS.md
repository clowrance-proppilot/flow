# Flow Agent Instructions

These instructions apply to coding agents working in this repository. Longer
prompt text for agent hosts lives in `prompts/`.

## Dogfood Flow

- When working on a Flow issue, use Flow as the workflow source of truth before
  editing code.
- Prefer registered `flow_*` tools when they are available. Otherwise use the
  `flow` JSON CLI and parse its JSON stdout.
- Select or create the issue, prepare or adopt the workspace, and claim or
  record the work through Flow before making implementation changes.
- Do not silently bypass Flow by editing the primary checkout for issue work. If
  Flow cannot prepare/adopt a workspace or record the work, stop and surface the
  exact blocker before continuing directly.
- Record results, evidence, tests, pull request state, and handoff notes through
  Flow.

## Repo Hygiene

- Inspect large files with `rg` or targeted line-range reads before reading the
  whole file. Never read a file over 50 KB in full when a targeted search gives
  the same answer.
- Prefer `rg -n "search term" path/to/file` to find relevant locations, then
  read only those ranges.
- Flow test files are split by domain. When working on readiness, check
  `test/readiness.test.ts`. For autoflow, check
  `test/work-runtime-autoflow.test.ts`. For adapter/triage, check
  `test/adapter-triage.test.ts`.
- Work as the executor. Do not delegate implementation or review work to another
  agent or advisor process.

## Configuration And Boundaries

- Keep Flow's durable configuration in `.flow/config.yaml`, following a
  Kubernetes-style declarative config model.
- Do not make environment variables the primary configuration surface for
  workflow topology, provider selection, executor policy, ports, ledgers, or
  other durable settings.
- Environment variables are acceptable for process context, local launch
  mechanics, and secret injection when a concrete adapter requires them, but
  config should remain the source of truth for behavior.
- Use command-line flags only for one-off command input, not durable settings.
- Flow CLI stdout is always JSON; do not add human-output modes or `--json`
  toggles.
- Keep SDKs, CLIs, issue trackers, code review tools, and model providers behind
  plugin or adapter boundaries.

## Prompt Files

- `prompts/agents.md` is the general coding-agent prompt for working on Flow.
- `prompts/flow.md` is for hosts where the agent is already acting as Flow and
  has registered Flow tools.
