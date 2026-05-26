---
name: flow
description: Use for project workflow through the Flow agent-facing guide.
---

# Flow

Use this skill when the user asks what needs attention, wants to work an issue,
asks how to unblock something, or asks for review readiness.

Use Flow's agent surface for workflow state, handoff results, evidence, PR
handoff, closeout, merge, and provider verification.

Prefer registered Flow tools. Use the CLI only when this skill is installed
without tool bindings. Stdout is JSON.

Do not write provider, ledger, sprint, or git workflow state directly unless the
requester approves recovery after a Flow failure.

If a Flow mutation fails, stop and report the exact tool or CLI error.
