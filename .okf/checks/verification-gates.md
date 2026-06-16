---
type: Verification Reference
title: Verification Gates
description: Flow's release and readiness checks are explicit npm scripts and focused domain tests.
tags: [verification, tests, readiness]
---

# Contract

Use Flow's focused npm scripts and domain tests rather than a single undifferentiated test pass. The main `check` script combines MCP contract checks, dashboard read-only checks, core import-boundary checks, core docs checks, and TypeScript compilation.

Release-oriented verification includes `npm run check`, `npm test`, `npm run build`, `npm run smoke:flow`, `npm run smoke:dashboard`, and `npm run readiness:public`.

# Source Pointers

- `package.json` owns the script names.
- `README.md` lists release checks.
- `AGENTS.md` points agents to domain-specific test files.

# Citations

[1] [package.json](../../package.json)  
[2] [README.md](../../README.md)  
[3] [AGENTS.md](../../AGENTS.md)
