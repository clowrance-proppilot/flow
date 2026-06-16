---
type: Architecture Boundary
title: Adapter Boundary
description: Flow keeps provider-specific details behind adapter and plugin boundaries.
tags: [adapters, providers, architecture]
---

# Contract

Issue trackers, code review tools, source control, agent SDKs, and execution planes should not leak provider-specific state into Flow's durable workflow topology.

Adapters handle provider APIs, SDKs, auth, request/response parsing, raw provider IDs, URLs, and statuses. Flow core should depend on provider-neutral capabilities and keep routing and workflow decisions in neutral fields.

Related concepts: [Flow-Managed Config](/contracts/flow-managed-config.md).

# Source Pointers

- `docs/adapter-authoring.md` owns adapter responsibilities and plugin-boundary guidance.
- `src/adapters/` contains provider adapters.
- `src/adapters/provider-contracts.ts` defines provider-facing contracts.

# Citations

[1] [docs/adapter-authoring.md](../../docs/adapter-authoring.md)  
[2] [src/adapters](../../src/adapters)  
[3] [src/adapters/provider-contracts.ts](../../src/adapters/provider-contracts.ts)
