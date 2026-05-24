# Why Flow

Flow is local workflow infrastructure for agent-assisted software work. It is
not trying to orchestrate agents as the product. It does not replace a team's
issue tracker, Git workflow, code review process, CI, IDE, or coding agent. It
gives those existing tools a durable workflow layer so work can be routed,
resumed, reviewed, and closed out without relying on chat history as the
workflow record.

Most developer AI tools are optimized for the coding session: edit these files,
answer this question, run this command, or open a PR. Agent orchestrators are
usually optimized for assigning work to one or more agents. Flow is optimized for
the work lifecycle around those sessions:

- what issue or local work item is active
- which repo and worktree own the work
- what the current readiness blockers are
- whether work has been handed off and what result came back
- what evidence, tests, review state, and handoff notes have been recorded
- whether the next valid action is implementation, verification, remediation, or
  closeout

The goal is to enhance existing development lifecycles, not replace them. A team
can keep Jira or GitHub Issues, its normal branch and PR rules, its existing CI,
and whichever human or agent coding tools it already uses. Flow sits beside
those systems and records the operational truth needed to coordinate the work,
not to make agent orchestration the center of the process.

## What Flow Adds

Flow adds a small set of durable workflow primitives:

- **Declarative repo configuration** in `.flow/config.yaml` for topology,
  provider choices, dashboard settings, execution adapter policy, and ledger
  behavior.
- **A CLI control surface** that emits JSON and routes workflow decisions through
  Work Runtime.
- **A workflow ledger** that keeps issue state, execution attempts, evidence,
  readiness, handoff, and closeout outside ephemeral chat context.
- **Reconciliation** across issue tracker, source control, code review, local
  worktrees, execution results, and Flow's ledger before deciding the next
  action.
- **Adapter boundaries** for issue trackers, code review tools, agent SDKs,
  model providers, and executors.
- **An operator dashboard** that reads CLI-reconciled state without becoming a
  second workflow authority.

## What Flow Is Not

Flow is not an IDE, coding model, hosted CI system, ticket tracker, PR review
replacement, or agent orchestrator. It does not need to own the whole software
delivery lifecycle to be useful. Its job is to make the agent-assisted parts of
that lifecycle explicit, auditable, and resumable.

That means Flow requests handoffs and records execution results, but launching
or managing agents belongs outside Flow. The thesis is that software teams need
a durable workflow authority around agent-assisted work: what is active, what is
ready, what changed, what evidence exists, what is blocked, and what should
happen next.

Flow should also not turn environment variables into the primary configuration
surface. Durable behavior belongs in `.flow/config.yaml`; environment variables
remain useful for process context, local launch mechanics, and secret injection.

## Alternatives And Adjacent Tools

Flow overlaps with several categories but takes a narrower position:

- **AI coding agents and editors** such as Codex, Claude Code, Cursor, GitHub
  Copilot, and Aider help produce and change code. Flow can coordinate them as
  executors but does not try to become the editor or model.
- **Agent orchestration frameworks** such as LangGraph, CrewAI, AutoGen,
  Semantic Kernel, and similar libraries help developers build agent systems.
  Flow is focused on repository workflow state and operator control for software
  work, not general-purpose agent application development.
- **Coding-agent orchestrators** such as Optio, Bernstein, AgentPipe, and other
  multi-agent developer workflow tools run or coordinate agents around tasks.
  Flow's distinctive boundary is almost the inverse: it treats agent execution as
  one possible adapter behind a durable developer workflow, while the repo owns
  declarative config, the CLI is the JSON protocol surface, and the ledger is the
  workflow record.
- **Workflow engines** such as Temporal, Conductor, and BPMN-style platforms
  provide durable process execution. Flow borrows the discipline of durable
  state and replayable history, but keeps the control surface local and
  developer-workflow specific.

That positioning is intentional. Flow should make existing delivery systems more
coherent for agent-assisted work instead of asking teams to move their process
into a new all-in-one platform.

## Demo Narrative

A concise Flow demo can stay focused on one lifecycle:

1. Bootstrap or inspect a repo-owned `.flow/config.yaml`.
2. Show the queue or adopt a local branch as Flow work.
3. Select work and inspect readiness.
4. Run or hand off implementation through a live thread or background executor.
5. Record evidence and tests.
6. Reconcile PR/review state.
7. Close out from the same CLI-governed workflow path.

The useful point is not that Flow writes code by itself. The useful point is that
Flow keeps the surrounding workflow state durable while humans and agents keep
using their existing tools.
