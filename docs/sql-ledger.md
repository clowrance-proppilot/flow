# SQL Ledger

Flow supports SQLite as an alternative to the default JSONL workflow ledger. The SQL ledger provides better performance for large datasets and supports atomic transactions.

## Configuration

To use the SQL ledger, set the ledger type in `.flow/config.yaml`:

```yaml
ledger:
  type: sql
```

The SQL ledger database will be stored at `.flow/ledger/workflow.db` by default.

## Migration from JSONL

If you have existing data in a JSONL ledger, you can migrate it to SQL using the CLI:

```bash
flow '{"op":"ledger","mode":"migrate"}'
```

This will read from `.flow/ledger/workflow.jsonl` and write to `.flow/ledger/workflow.db`.

You can also specify custom paths:

```bash
flow '{"op":"ledger","mode":"migrate","jsonlPath":"/path/to/workflow.jsonl","sqlPath":"/path/to/workflow.db"}'
```

## Verification

To verify a JSONL ledger:

```bash
flow '{"op":"ledger","mode":"verify"}'
```

To rebuild projections during verification:

```bash
flow '{"op":"ledger","mode":"verify","rebuildProjections":true}'
```

## Programmatic Usage

```typescript
import { SqlWorkflowLedger, migrateJsonlToSql } from "@camden-lowrance/flow";

// Create a SQL ledger
const ledger = new SqlWorkflowLedger({ path: ".flow/ledger/workflow.db" });

// Migrate from JSONL
const result = await migrateJsonlToSql({
  jsonlPath: ".flow/ledger/workflow.jsonl",
  sqlPath: ".flow/ledger/workflow.db",
});
console.log(`Migrated ${result.recordsMigrated} of ${result.recordsProcessed} records`);
```

## SQL Schema

The SQL ledger uses the following tables:

- `issues`: Stores work items (issues) with their full JSON data
- `worker_runs`: Stores worker run records
- `worker_results`: Stores worker task results
- `work_jobs`: Stores work jobs
- `work_job_results`: Stores work job results
- `context_records`: Stores context records (threads, prompts, sessions, artifacts)

All tables include appropriate indexes for efficient querying.
