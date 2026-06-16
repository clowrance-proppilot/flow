---
type: Contract
title: MCP Surface
description: Flow exposes typed MCP tools as its only external command surface.
tags: [mcp, surface, agents]
---

# Contract

`flow` starts a stdio MCP server. Hosts should discover and call explicit `flow_*` tools for project registration, issue state, workspace preparation, workflow advancement, evidence, results, documentation, and pull request records.

Flow does not accept JSON command bodies through argv or stdin, and it does not expose a raw runtime-method bridge. If a bookkeeping operation needs to be external, it should be represented as a typed MCP tool.

Related concepts: [Flow-Managed Config](/contracts/flow-managed-config.md), [Agent Bookkeeping](/workflows/agent-bookkeeping.md).

# Source Pointers

- `README.md` defines the MCP-only agent surface and core tools.
- `docs/mcp-reference.md` is the command-shape reference.
- `docs/migration-to-mcp.md` explains the removed JSON command surface.

# Citations

[1] [README.md](../../README.md)  
[2] [docs/mcp-reference.md](../../docs/mcp-reference.md)  
[3] [docs/migration-to-mcp.md](../../docs/migration-to-mcp.md)
