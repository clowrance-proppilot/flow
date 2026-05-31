import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  createKyselyFlowState,
  createPostgresSqlStateConfig,
  createSqliteSqlStateConfig,
  nowIso,
} from "../src/index.js";

test("KyselyFlowState stores sessions, events, workflow records, context, and project state in SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-sql-state-"));
  const state = createKyselyFlowState({
    root,
    dialectConfig: createSqliteSqlStateConfig({ root }),
  });
  try {
    await state.ensure();

    const session = await state.createSession("sql-session");
    await state.writeSession({ ...session, selectedIssueRef: "GH-313", selectedRepoKey: "flow" });
    const readSession = await state.readSession("sql-session");
    assert.equal(readSession?.selectedIssueRef, "GH-313");

    const event = await state.appendEvent({
      sessionId: "sql-session",
      type: "sql.test",
      message: "SQL state event",
      payload: { ok: true },
    });
    assert.equal(event.type, "sql.test");

    await state.writeIssue({
      ref: "GH-313",
      title: "Build Kysely SQL state layer",
      repoKeys: ["flow"],
      state: "selected",
      metadata: { lane: "sql" },
    });
    await state.recordWorkerRun({
      taskId: "worker-1",
      issueRef: "GH-313",
      repoKey: "flow",
      executor: "live_agent_thread",
      status: "running",
      blockers: [],
      startedAt: nowIso(),
      updatedAt: nowIso(),
    });
    await state.recordWorkerResult({
      taskId: "worker-1",
      issueRef: "GH-313",
      repoKey: "flow",
      executor: "live_agent_thread",
      status: "succeeded",
      summary: "Implemented SQL state.",
      changedFiles: ["src/sql-state.ts"],
      testsRun: ["npm test"],
      blockers: [],
      completedAt: nowIso(),
    });
    await state.recordWorkJob({
      id: "job-1",
      issueRef: "GH-313",
      repoKey: "flow",
      workType: "flow.implement",
      status: "queued",
      input: {},
      requiredCapabilities: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    await state.recordWorkJobResult({
      jobId: "job-1",
      issueRef: "GH-313",
      repoKey: "flow",
      workType: "flow.implement",
      status: "succeeded",
      summary: "Job completed.",
      evidence: ["unit test"],
      completedAt: nowIso(),
    });
    await state.recordContext({
      id: "artifact-1",
      kind: "artifact",
      projectId: "flow-project",
      issueRef: "GH-313",
      artifactType: "test_output",
      title: "SQL state test",
    });
    await state.setProjectState("flow-project", "autoflow.enabled", false);

    assert.equal((await state.readIssue("GH-313"))?.title, "Build Kysely SQL state layer");
    assert.equal((await state.listIssues()).length, 1);
    assert.equal((await state.listWorkerRuns("GH-313")).length, 1);
    assert.equal((await state.listWorkerResults("GH-313"))[0].status, "succeeded");
    assert.equal((await state.listWorkJobs("GH-313"))[0].id, "job-1");
    assert.equal((await state.listWorkJobResults("GH-313"))[0].jobId, "job-1");
    assert.equal((await state.readContext({ issueRef: "GH-313" })).artifacts[0].id, "artifact-1");
    assert.equal(await state.getProjectState("flow-project", "autoflow.enabled"), false);
  } finally {
    await state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Postgres SQL state config exposes a dialect boundary without requiring a live database", () => {
  const config = createPostgresSqlStateConfig({ connectionString: "postgres://flow@example.local/flow" });
  assert.equal(config.kind, "postgres");
  assert.equal(config.connectionString, "postgres://flow@example.local/flow");
  assert.equal(config.dialect, undefined);
  assert.throws(
    () => createKyselyFlowState({ dialectConfig: config }),
    /requires a Kysely dialect/,
  );
});
