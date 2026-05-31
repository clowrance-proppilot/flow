import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  type WorkItem,
  type WorkJob,
  type WorkJobResult,
  type FlowContextRecord,
  type WorkerRunRecord,
  type WorkerTaskResult,
  flowContextRecordSchema,
  workItemSchema,
  workJobResultSchema,
  workJobSchema,
  workerRunRecordSchema,
  workerTaskResultSchema,
} from "./contracts.js";
import { SqlWorkflowLedger } from "./sql-ledger.js";

type JsonlWorkflowLedgerRecord =
  | { kind: "issue"; value: WorkItem }
  | { kind: "workerRun"; value: WorkerRunRecord }
  | { kind: "workerResult"; value: WorkerTaskResult }
  | { kind: "workJob"; value: WorkJob }
  | { kind: "workJobResult"; value: WorkJobResult }
  | { kind: "context"; value: FlowContextRecord };

export interface MigrateJsonlToSqlOptions {
  jsonlPath: string;
  sqlPath: string;
}

export interface MigrateJsonlToSqlResult {
  ok: boolean;
  recordsProcessed: number;
  recordsMigrated: number;
  errors: Array<{ line: number; message: string }>;
}

export async function migrateJsonlToSql(options: MigrateJsonlToSqlOptions): Promise<MigrateJsonlToSqlResult> {
  const { jsonlPath, sqlPath } = options;
  const errors: Array<{ line: number; message: string }> = [];
  let recordsProcessed = 0;
  let recordsMigrated = 0;

  if (!existsSync(jsonlPath)) {
    return { ok: true, recordsProcessed: 0, recordsMigrated: 0, errors: [] };
  }

  const sqlLedger = new SqlWorkflowLedger({ path: sqlPath });

  try {
    const raw = await readFile(jsonlPath, "utf8");
    const lines = raw.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      recordsProcessed++;
      const lineNumber = i + 1;

      try {
        const record = parseJsonlRecord(JSON.parse(line));
        await applyRecord(sqlLedger, record);
        recordsMigrated++;
      } catch (error) {
        errors.push({
          line: lineNumber,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    sqlLedger.close();
  }

  return {
    ok: errors.length === 0,
    recordsProcessed,
    recordsMigrated,
    errors,
  };
}

function parseJsonlRecord(value: unknown): JsonlWorkflowLedgerRecord {
  if (typeof value !== "object" || value === null) throw new Error("Ledger record must be an object.");
  const kind = (value as { kind?: unknown }).kind;
  const recordValue = (value as { value?: unknown }).value;

  if (kind === "issue") return { kind, value: workItemSchema.parse(recordValue) };
  if (kind === "workerRun") return { kind, value: workerRunRecordSchema.parse(recordValue) };
  if (kind === "workerResult") return { kind, value: workerTaskResultSchema.parse(recordValue) };
  if (kind === "workJob") return { kind, value: workJobSchema.parse(recordValue) };
  if (kind === "workJobResult") return { kind, value: workJobResultSchema.parse(recordValue) };
  if (kind === "context") return { kind, value: flowContextRecordSchema.parse(recordValue) };
  throw new Error(`Unsupported ledger record kind: ${String(kind)}.`);
}

async function applyRecord(ledger: SqlWorkflowLedger, record: JsonlWorkflowLedgerRecord): Promise<void> {
  switch (record.kind) {
    case "issue":
      await ledger.writeIssue(record.value);
      break;
    case "workerRun":
      await ledger.recordWorkerRun(record.value);
      break;
    case "workerResult":
      await ledger.recordWorkerResult(record.value);
      break;
    case "workJob":
      await ledger.recordWorkJob(record.value);
      break;
    case "workJobResult":
      await ledger.recordWorkJobResult(record.value);
      break;
    case "context":
      await ledger.recordContext(record.value);
      break;
  }
}
