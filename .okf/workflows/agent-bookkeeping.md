---
type: Workflow Contract
title: Agent Bookkeeping
description: Flow records coding-agent workflow state while local agents perform implementation work.
tags: [agents, workflow, evidence]
---

# Contract

Flow is the MCP work record for agents. Agents use Flow to select work, prepare or adopt workspaces, request or read handoff state, and record evidence, results, documentation disposition, pull request state, blockers, and next pickup notes.

Local agent processes may perform implementation, but Flow remains the bookkeeping record. Autoflow, Desktop/UI status, and background reconciliation are experimental app-layer behavior above this contract, not the default executor path.

Related concepts: [MCP Surface](/surfaces/mcp.md), [Dashboard Boundary](/surfaces/dashboard.md).

# Source Pointers

- `docs/agent-handoff.md` owns the local-thread workflow loop.
- `AGENTS.md` defines the repo-local agent rules.
- `docs/getting-started.md` introduces first workflow operations.

# Citations

[1] [docs/agent-handoff.md](../../docs/agent-handoff.md)  
[2] [AGENTS.md](../../AGENTS.md)  
[3] [docs/getting-started.md](../../docs/getting-started.md)
