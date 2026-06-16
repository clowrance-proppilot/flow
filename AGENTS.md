# Flow Agent Instructions

These instructions apply to coding agents working in this repository. Longer
prompt text for agent hosts lives in `prompts/`.

## Dogfood Flow (Core Bookkeeping)

- When working on a Flow issue, use Flow for bookkeeping before editing code.
- Use registered `flow_*` MCP tools. If those tools are unavailable, stop and
  surface that Flow MCP is not connected; do not fall back to a JSON CLI.
- Core Flow commands are deterministic bookkeeping: issue create/select, workspace
  prepare/adopt, result/evidence/documentation/PR recording, and bounded workflow
  state transitions. Use these directly.
- For simple issue capture, use `flow_issue_create` directly. Do not run intake
  review or semantic dedupe unless specifically needed.
- Do not silently bypass Flow by editing the primary checkout for issue work. If
  Flow cannot prepare/adopt a workspace or record the work, stop and surface the
  exact blocker before continuing directly.
- Record results, evidence, tests, pull request state, and handoff notes through
  Flow.

### Experimental App-Layer Behavior

- Autoflow (live-agent orchestration), Desktop/UI status, and background
  reconciliation are experimental app-layer behavior—not core bookkeeping.
- Do not use Autoflow as the default executor. Use direct Flow commands for
  issue work unless the requester explicitly asks for the Autoflow path.
- Do not spawn agents, poll background status, or run multi-step closeout loops
  from core Flow commands.

## Repo Hygiene

- Inspect large files with `rg` or targeted line-range reads before reading the
  whole file. Never read a file over 50 KB in full when a targeted search gives
  the same answer.
- Prefer `rg -n "search term" path/to/file` to find relevant locations, then
  read only those ranges.
- The repo's thin OKF knowledge projection lives in `.okf/`. Use it as a
  navigation aid for stable repo contracts; canonical docs, code, tests, Flow
  MCP state, and Flow-managed config remain the sources of truth. Use
  `skills/okf-repo-projection` to refresh it.
- Flow test files are split by domain. When working on readiness, check
  `test/readiness.test.ts`. For autoflow orchestration (experimental app layer),
  check `test/experimental/work-runtime-autoflow.test.ts`. For adapter/triage,
  check `test/adapter-triage.test.ts`.
- Work as the executor. Do not delegate implementation or review work to another
  agent or advisor process.

## Configuration And Boundaries

- Keep Flow's durable configuration behind MCP. Use `flow_bootstrap`,
  `flow_config_get`, and `flow_config_update`; do not edit a project config
  file directly.
- Do not make environment variables the primary configuration surface for
  workflow topology, provider selection, executor policy, ports, ledgers, or
  other durable settings.
- Environment variables are acceptable for process context, local launch
  mechanics, and secret injection when a concrete adapter requires them, but
  Flow-managed config should remain the source of truth for behavior.
- Use command-line flags only for one-off command input, not durable settings.
- Flow CLI stdout is always JSON; do not add human-output modes or `--json`
  toggles.
- Keep SDKs, CLIs, issue trackers, code review tools, and model providers behind
  plugin or adapter boundaries.

## Prompt Files

- `prompts/agents.md` is the general coding-agent prompt for working on Flow.
- `prompts/flow.md` is for hosts where the agent is already acting as Flow and
  has registered Flow tools.
