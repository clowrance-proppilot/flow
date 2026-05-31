# Flow Test Categories

`npm test` runs the full required suite (check contracts + all tests).
Category commands let you run a focused subset during development.

## Available categories

| Category          | Command                    | What it covers                                      |
| ----------------- | -------------------------- | --------------------------------------------------- |
| **config**        | `npm run test:config`      | Config schema, loader, validator, migrate, bootstrap, topology, work-type registry |
| **runtime**       | `npm run test:runtime`     | FlowWorkRuntime session/advance/handoff, autoflow, local executor, work envelopes, Beads metadata |
| **desktop**       | `npm run test:desktop`     | DesktopProjectRegistry, DesktopPromptRouter, DesktopActionRouter, PiSessionDriver, PiAgentOrchestrator, project theme |
| **dashboard**     | `npm run test:dashboard`   | DashboardState, inspectDashboardQueue               |
| **readiness**     | `npm run test:readiness`   | assessIssue readiness rules                          |
| **ledger**        | `npm run test:ledger`      | MemoryWorkflowLedger, MirroredWorkflowLedger, JSONL persistence, context records, verification |
| **adapters**      | `npm run test:adapters`    | Jira adapter, GitHub adapter, provider CLI error classification |
| **reconciliation**| `npm run test:reconciliation` | PR reconciliation, doctor diagnostics              |

## How it works

Each category maps to a regex pattern passed to `node:test`'s `testNamePatterns`
option. Categories may overlap; `npm test` always runs everything.

You can also pass a custom pattern directly:

```sh
node scripts/test-flow.mjs --test-name-pattern "readiness|reconciliation"
```

To see all built-in category patterns:

```sh
node scripts/test-flow.mjs --list-categories
```

## Acceptance criteria

- [x] At least three useful categories can be run independently.
- [x] `npm test` still runs all required tests.
- [x] Category commands are documented here and in `package.json` scripts.
- [x] Existing tests are not silently dropped from the full suite.
