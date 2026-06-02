# Flow Test Commands

`npm test` is the full required suite. It runs the CLI contract checks, the
dashboard read-only contract check, and every test file in `scripts/test-flow.mjs`.

For faster local feedback, use one of the explicit category scripts:

| Command | Files |
| --- | --- |
| `npm run test:core` | `test/flow.test.ts` |
| `npm run test:autoflow` | `test/experimental/autoflow-runner.test.ts` |
| `npm run test:dashboard` | `test/dashboard-state.test.ts` |
| `npm run test:sql` | `test/sql-state.test.ts`, `test/sql-store.test.ts` |

You can also pass files directly to the fast runner:

```bash
npm run test:fast -- test/sql-store.test.ts
```

To generate the local V8 coverage report:

```bash
npm run test:coverage
```

Coverage output is written under `coverage/v8/`, which is ignored by git.

Add a new category script when a test file becomes a stable local feedback
boundary. Do not remove a file from `scripts/test-flow.mjs` unless it should no
longer run in the full required suite.

## Fixtures

Shared setup helpers live in `test/helpers/fixtures.ts`.

- `withTempFlowRoot(prefix, run)` creates and cleans up a temporary Flow root.
- `withSqlFlowStore(prefix, run)` creates, ensures, closes, and cleans up a `SqlFlowStore`.
- `withFileFlowStore(prefix, run)` creates, ensures, and cleans up a file-backed `FlowStore`.

Use these helpers for repeated setup. Keep assertions in the test body so each
test still shows the behavior it proves.
