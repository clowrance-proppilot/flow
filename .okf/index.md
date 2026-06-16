---
okf_version: "0.1"
---

# Flow Knowledge Projection

This bundle is a thin OKF projection over Flow's canonical repo sources. It helps agents locate stable contracts without turning OKF into workflow state, project config, or a mirrored documentation tree.

Refresh this projection with the vendored skill at `skills/okf-repo-projection/`.

# Core Contracts

* [MCP Surface](surfaces/mcp.md) - The typed `flow_*` MCP server is Flow's only external command surface.
* [Flow-Managed Config](contracts/flow-managed-config.md) - Durable topology and provider behavior belongs in Flow-managed config, updated through MCP tools.
* [Agent Bookkeeping](workflows/agent-bookkeeping.md) - Agents use Flow for issue selection, workspaces, evidence, results, docs disposition, PRs, and blockers.
* [Adapter Boundary](adapters/provider-boundary.md) - Provider-specific SDKs, IDs, and APIs stay behind adapter or plugin boundaries.
* [Dashboard Boundary](surfaces/dashboard.md) - The dashboard is a read-only human mirror over Flow state.
* [Verification Gates](checks/verification-gates.md) - Release and readiness checks are explicit npm scripts and focused domain tests.

# Citations

[1] [Open Knowledge Format v0.1 Spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
