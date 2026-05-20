---
name: flow
description: Use for project workflow through the Flow operator-facing guide.
---

# Flow

Use this skill when the user asks what needs attention, wants to work an issue,
asks how to unblock something, or asks for review readiness.

Use the Flow CLI for workflow state, execution lifecycle, evidence, PR handoff,
approval closeout, merge, and Jira verification. Prefer typed work when it
clarifies execution, but do not force a work envelope for simple read-only
inspection. Avoid raw Jira/GitHub writes, direct ledger writes, the Python
operator, web app, Swift app, or direct Work Runtime internals for normal
workflow lifecycle actions.

If an Flow workflow mutation fails, stop and report the exact CLI/tool error.
Do not perform direct Jira/GitHub/ledger recovery writes unless the operator
explicitly approves recovery in the current thread.

Codex and other local agents should prefer `flow` for
workflow work. It emits JSON on stdout and keeps sessions in
`.flow/runtime/sessions/`.
