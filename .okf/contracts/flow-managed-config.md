---
type: Contract
title: Flow-Managed Config
description: Durable Flow behavior is owned by Flow-managed config, not project file edits or environment variables.
tags: [config, topology, mcp]
---

# Contract

Flow-managed config is the durable source of truth for topology, adapter selection, execution policy, dashboard settings, runtime store, and ledger selection.

Agents initialize and update config through MCP tools such as `flow_bootstrap`, `flow_config_get`, `flow_config_update`, `flow_config_validate`, and `flow_config_explain`. Environment variables are acceptable for process context, launch mechanics, and secret injection, but they should not become the durable selector for topology, providers, ports, ledgers, or executor policy.

Related concepts: [MCP Surface](/surfaces/mcp.md), [Adapter Boundary](/adapters/provider-boundary.md).

# Source Pointers

- `docs/config-reference.md` owns the config contract and update shape.
- `README.md` summarizes config ownership in the agent contract.
- `AGENTS.md` repeats the boundary for agents working in this repo.

# Citations

[1] [docs/config-reference.md](../../docs/config-reference.md)  
[2] [README.md](../../README.md)  
[3] [AGENTS.md](../../AGENTS.md)
