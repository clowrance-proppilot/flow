---
type: Contract
title: Dashboard Boundary
description: The Flow dashboard is a read-only human mirror over workflow state.
tags: [dashboard, runtime, readonly]
---

# Contract

`flow-dashboard` serves a human view over Flow state. It reads the dashboard snapshot and does not expose workflow command routes, action endpoints, or agent orchestration controls.

Mutations go through Flow MCP tools. Dashboard interactions such as filtering, search, refresh, and copying handoff text only affect the local view or clipboard.

Related concepts: [MCP Surface](/surfaces/mcp.md), [Agent Bookkeeping](/workflows/agent-bookkeeping.md).

# Source Pointers

- `docs/runtime-and-dashboard.md` owns dashboard state-source and read-only boundary guidance.
- `scripts/check-dashboard-readonly.mjs` enforces the dashboard read-only route boundary.
- `test/dashboard-state.test.ts` covers dashboard projection behavior.

# Citations

[1] [docs/runtime-and-dashboard.md](../../docs/runtime-and-dashboard.md)  
[2] [scripts/check-dashboard-readonly.mjs](../../scripts/check-dashboard-readonly.mjs)  
[3] [test/dashboard-state.test.ts](../../test/dashboard-state.test.ts)
