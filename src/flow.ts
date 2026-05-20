#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { join } from "node:path";

import {
  AcliJiraAdapter,
  assessIssue,
  createDefaultWorkerSpawner,
  createWorkflowLedger,
  configToProjectTopology,
  configToWorkTypeRegistry,
  FlowStore,
  FlowWorkRuntime,
  GhGitHubAdapter,
  JsonlFlowEventLedger,
  loadFlowConfig,
  type WorkItem,
} from "./index.js";
import { loadFlowEnv, repoRoot } from "./flow-runtime.js";

loadFlowEnv();

const defaultSessionId = process.env.FLOW_SESSION_ID ?? "cli";
const flowConfig = await loadFlowConfig({ projectRoot: repoRoot });
const flowEvents = new JsonlFlowEventLedger(join(repoRoot, ".context", "flow", "events.jsonl"));
const runtime = new FlowWorkRuntime({
  store: new FlowStore({ root: join(repoRoot, ".context", "flow", "runtime") }),
  ledger: createWorkflowLedger({ cwd: repoRoot }),
  github: new GhGitHubAdapter({ cwd: repoRoot }),
  jira: new AcliJiraAdapter({ cwd: repoRoot }),
  flowEventLedger: flowEvents,
  ...(flowConfig
    ? {
      topology: configToProjectTopology(flowConfig),
      workTypes: configToWorkTypeRegistry(flowConfig),
    }
    : {}),
  projectRoot: repoRoot,
  readiness: { assess: assessIssue },
});

const program = new Command()
  .name("flow")
  .description("Flow agent protocol CLI. Emits JSON on stdout and diagnostics on stderr.")
  .helpOption(false)
  .configureOutput({
    writeOut: (value) => process.stderr.write(value),
    writeErr: (value) => process.stderr.write(value),
  })
  .action(() => {
    writeJson({
      ok: false,
      error: "command required",
      commands: ["commands", "session", "queue", "backlog", "select", "advance", "autoflow", "doctor", "handoff", "observe", "call"],
    });
    process.exitCode = 1;
  });

program
  .command("commands")
  .description("Emit supported agent protocol commands.")
  .action(() => writeJson({
    commands: ["session", "queue", "backlog", "select", "advance", "autoflow", "doctor", "handoff", "observe", "call"],
    stdout: "json",
    stderr: "diagnostics",
  }));

program
  .command("session")
  .description("Create or overwrite a named Work Runtime session.")
  .argument("[id]", "session id", defaultSessionId)
  .action(async (id: string) => writeJson(await runtime.createSession(id)));

program
  .command("queue")
  .description("Inspect current Jira sprint queue.")
  .option("-l, --limit <count>", "issue limit", parsePositiveInteger, 10)
  .action(async (options: { limit: number }) => writeJson(await runtime.inspectQueue(options.limit)));

program
  .command("backlog")
  .description("Inspect current Jira backlog.")
  .option("-l, --limit <count>", "issue limit", parsePositiveInteger, 10)
  .action(async (options: { limit: number }) => writeJson(await runtime.inspectBacklog(options.limit)));

program
  .command("select")
  .description("Select an issue in a file-backed Work Runtime session.")
  .argument("<issue-ref>", "Jira issue key")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .action(async (issueRef: string, options: { session: string }) => {
    await ensureSession(options.session);
    writeJson(await runtime.selectIssue(options.session, await queueIssue(issueRef)));
  });

program
  .command("advance")
  .description("Advance a selected issue, or select the issue first when provided.")
  .argument("[issue-ref]", "Jira issue key")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .option("--approve <confirmation-id>", "approve pending confirmation id")
  .action(async (issueRef: string | undefined, options: { session: string; approve?: string }) => {
    await ensureSession(options.session);
    if (issueRef) await runtime.selectIssue(options.session, await queueIssue(issueRef));
    writeJson(await runtime.advanceIssue(options.session, options.approve));
  });

program
  .command("autoflow")
  .description("Run deterministic autoflow for an issue.")
  .argument("<issue-ref>", "Jira issue key")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .option("--steps <count>", "maximum Work Runtime autoflow steps", parsePositiveInteger, 20)
  .option("--no-worker", "do not run a background executor")
  .action(async (issueRef: string, options: { session: string; steps: number; worker: boolean }) => {
    await ensureSession(options.session);
    await runtime.selectIssue(options.session, await queueIssue(issueRef));
    writeJson(await runtime.autoFlowIssue(
      options.session,
      createDefaultWorkerSpawner({ flowRoot: repoRoot }),
      {
        autoPrepareWorkspace: true,
        autoApproveWorker: true,
        runWorker: options.worker,
        maxSteps: options.steps,
      },
    ));
  });

program
  .command("doctor")
  .description("Diagnose Flow visibility, routing, PR state, readiness blockers, and next action.")
  .argument("[issue-ref]", "Jira issue key")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .action(async (issueRef: string | undefined, options: { session: string }) => {
    await ensureSession(options.session);
    if (issueRef) await runtime.selectIssue(options.session, await queueIssue(issueRef));
    writeJson(await runtime.diagnoseIssue(options.session, issueRef));
  });

program
  .command("handoff")
  .description("Summarize current session handoff state.")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .action(async (options: { session: string }) => {
    await ensureSession(options.session);
    writeJson(await runtime.summarizeHandoff(options.session));
  });

program
  .command("observe")
  .description("Observe projected Flow Core state for a subject.")
  .argument("<ref>", "subject reference, defaults to issue ref")
  .option("-t, --type <type>", "subject type", "issue")
  .action(async (ref: string, options: { type: string }) => {
    writeJson(await runtime.observeFlowSubject({ type: options.type, ref }));
  });

program
  .command("call")
  .description("Call a Work Runtime method with raw JSON params.")
  .argument("<method>", "Work Runtime method")
  .argument("[params-json]", "JSON object params", "{}")
  .action(async (method: string, paramsJson: string) => {
    const params = JSON.parse(paramsJson) as Record<string, unknown>;
    writeJson(await dispatch(method, params));
  });

try {
  await program.exitOverride().parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    writeJson({ ok: false, error: error.message, code: error.code });
    process.exitCode = error.exitCode;
  } else {
  writeJson({ ok: false, error: errorMessage(error) });
  process.exitCode = 1;
  }
}

async function ensureSession(sessionId: string): Promise<void> {
  try {
    await runtime.summarizeHandoff(sessionId);
  } catch {
    await runtime.createSession(sessionId);
  }
}

async function queueIssue(issueRef: string): Promise<WorkItem> {
  const issueKey = issueRef.toUpperCase();
  const queue = await runtime.inspectQueue(50);
  const issue = queue.find((candidate) => candidate.ref.toUpperCase() === issueKey);
  if (issue) return issue;
  return { ref: issueKey, title: issueKey, repoKeys: [], state: "queued", metadata: {} };
}

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "inspectDashboardQueue":
      return runtime.inspectDashboardQueue(Number(params.limit ?? 10));
    case "inspectQueue":
      return runtime.inspectQueue(Number(params.limit ?? 10));
    case "inspectBacklog":
      return runtime.inspectBacklog(Number(params.limit ?? 10));
    case "createSession":
      return runtime.createSession(typeof params.id === "string" ? params.id : undefined);
    case "selectIssue":
      return runtime.selectIssue(String(params.sessionId ?? defaultSessionId), params.issue as WorkItem);
    case "bootstrapJiraIssue":
      return runtime.bootstrapJiraIssue(
        String(params.sessionId ?? defaultSessionId),
        String(params.issueRef),
        params.options ?? {},
      );
    case "routeIssue":
      return runtime.routeIssue(
        String(params.sessionId ?? defaultSessionId),
        String(params.issueRef),
        asStringArray(params.repoKeys) ?? [],
      );
    case "advanceIssue":
      return runtime.advanceIssue(String(params.sessionId ?? defaultSessionId), typeof params.approveConfirmationId === "string" ? params.approveConfirmationId : undefined);
    case "diagnoseIssue":
      return runtime.diagnoseIssue(
        String(params.sessionId ?? defaultSessionId),
        typeof params.issueRef === "string" ? params.issueRef : undefined,
      );
    case "autoFlowIssue":
      return runtime.autoFlowIssue(String(params.sessionId ?? defaultSessionId), createDefaultWorkerSpawner({ flowRoot: repoRoot }), params.options ?? {});
    case "resetAutoflowState":
      return runtime.resetAutoflowState(String(params.sessionId ?? defaultSessionId), asStringArray(params.issueRefs));
    case "summarizeHandoff":
      return runtime.summarizeHandoff(String(params.sessionId ?? defaultSessionId));
    case "observeFlowSubject":
      return runtime.observeFlowSubject({
        type: typeof params.type === "string" ? params.type : "issue",
        ref: String(params.ref),
      });
    default:
      throw new Error(`Unsupported CLI Work Runtime method: ${method}`);
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Expected a positive integer, got ${value}.`);
  return parsed;
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
