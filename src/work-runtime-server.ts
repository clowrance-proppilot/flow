#!/usr/bin/env node
import express from "express";
import { join } from "node:path";
import {
  createWorkflowLedger,
  FlowWorkRuntime,
  FlowStore,
  assessIssue,
  createDefaultWorkerSpawner,
  configToProjectTopology,
  configToWorkTypeRegistry,
  JsonlFlowEventLedger,
  loadFlowConfig,
} from "./index.js";
import { GhGitHubAdapter } from "./adapters/github.js";
import { GhGitHubIssueTrackerAdapter } from "./adapters/github.js";
import { AcliJiraAdapter } from "./adapters/jira.js";
import { FlowEventStream } from "./event-stream.js";
import { loadFlowEnv, repoRoot } from "./flow-runtime.js";
import type { FlowConfig } from "./config/config-schema.js";

loadFlowEnv();

const events = new FlowEventStream("work_runtime");
const flowConfig = await loadFlowConfig({ projectRoot: repoRoot });
const host = resolveRuntimeHost(flowConfig);
const port = resolveRuntimePort(flowConfig);
const flowEvents = new JsonlFlowEventLedger(join(repoRoot, ".context", "flow", "events.jsonl"));

const workRuntime = new FlowWorkRuntime({
  store: new FlowStore({ root: join(repoRoot, ".context", "flow", "runtime") }),
  ledger: createWorkflowLedger({ cwd: repoRoot }),
  github: new GhGitHubAdapter({ cwd: repoRoot, owner: configString(flowConfig?.collaboration, "owner") }),
  issueTracker: createIssueTracker(),
  flowEventLedger: flowEvents,
  defaultJiraProjectKey: configString(flowConfig?.issueTracker, "projectKey"),
  ...(flowConfig
    ? {
      topology: configToProjectTopology(flowConfig),
      workTypes: configToWorkTypeRegistry(flowConfig),
    }
    : {}),
  projectRoot: repoRoot,
  readiness: { assess: assessIssue },
});

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    role: "work_runtime",
    pid: process.pid,
    repoRoot,
  });
});

app.get("/v1/events", (req, res) => {
  events.subscribe(req, res);
});

app.post("/v1/work-runtime", async (req, res) => {
  const body = req.body as { method?: unknown; params?: unknown };
  const method = String(body.method ?? "");
  const params = isRecord(body.params) ? body.params : {};
  const startedAt = Date.now();
  try {
    publishMethodEvent(method, params, "started");
    const result = await dispatch(method, params);
    const durationMs = Date.now() - startedAt;
    logSlowMethod(method, params, durationMs);
    publishMethodEvent(method, params, "completed", { durationMs });
    res.json({ ok: true, result });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    logSlowMethod(method, params, durationMs);
    publishMethodEvent(method, params, "failed", { durationMs, error: error instanceof Error ? error.message : String(error) });
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.listen(port, host, () => {
  console.log(`Flow Work Runtime listening on http://${host}:${port}`);
});

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "inspectDashboardQueue":
      return workRuntime.inspectDashboardQueue(Number(params.limit ?? 10));
    case "inspectQueue":
      return workRuntime.inspectQueue(Number(params.limit ?? 10));
    case "inspectBacklog":
      return workRuntime.inspectBacklog(Number(params.limit ?? 10));
    case "createSession":
      return workRuntime.createSession(typeof params.id === "string" ? params.id : undefined);
    case "selectIssue":
      return workRuntime.selectIssue(String(params.sessionId), params.issue as never);
    case "bootstrapIssue":
    case "bootstrapJiraIssue":
      return workRuntime.bootstrapJiraIssue(
        String(params.sessionId),
        String(params.issueRef),
        params.options ?? {},
      );
    case "createJiraIssue":
      return workRuntime.createJiraIssue(String(params.sessionId), params.options as never);
    case "moveIssuesToActiveSprint":
      return workRuntime.moveIssuesToActiveSprint(
        String(params.sessionId),
        asStringArray(params.issueRefs),
        params.options ?? {},
      );
    case "routeIssue":
      return workRuntime.routeIssue(String(params.sessionId), String(params.issueRef), asStringArray(params.repoKeys));
    case "prepareWorkspace":
      return workRuntime.prepareWorkspace(String(params.sessionId), String(params.issueRef), params.options ?? {});
    case "advanceIssue":
      return workRuntime.advanceIssue(
        String(params.sessionId),
        typeof params.approveConfirmationId === "string" ? params.approveConfirmationId : undefined,
      );
    case "summarizeHandoff":
      return workRuntime.summarizeHandoff(String(params.sessionId));
    case "observeFlowSubject":
      return workRuntime.observeFlowSubject({
        type: typeof params.type === "string" ? params.type : "issue",
        ref: String(params.ref),
      });
    case "recordEvidence":
      return workRuntime.recordEvidence(String(params.sessionId), params.record as never);
    case "recordAcceptanceWriteback":
      return workRuntime.recordAcceptanceWriteback(
        String(params.sessionId),
        typeof params.issueRef === "string" ? params.issueRef : undefined,
      );
    case "closeoutAfterApproval":
      return workRuntime.closeoutAfterApproval(String(params.sessionId), params.options ?? {});
    case "recordReviewConfirmation":
      return workRuntime.recordReviewConfirmation(String(params.sessionId), params.record as never);
    case "recordDocumentation":
      return workRuntime.recordDocumentation(String(params.sessionId), params.record as never);
    case "recordProviderEscalation":
      return workRuntime.recordProviderEscalation(String(params.sessionId), params.record as never);
    case "recordPullRequest":
      return workRuntime.recordPullRequest(String(params.sessionId), params.record as never);
    case "refreshReviewState":
      return workRuntime.refreshReviewState(
        String(params.sessionId),
        typeof params.issueRef === "string" ? params.issueRef : undefined,
      );
    case "observeExecutors":
      return workRuntime.observeExecutors(
        String(params.sessionId),
        typeof params.issueRef === "string" ? params.issueRef : undefined,
      );
    case "listWorkJobs":
      return workRuntime.listWorkJobs(
        String(params.sessionId),
        typeof params.issueRef === "string" ? params.issueRef : undefined,
      );
    case "submitWorkEnvelope":
      return workRuntime.submitWorkEnvelope(String(params.sessionId), String(params.envelope));
    case "adoptLocalThread":
      return workRuntime.adoptLocalThread(String(params.sessionId), params.request as never, params.options ?? {});
    case "adoptPendingLocalThread":
      return workRuntime.adoptPendingLocalThread(String(params.sessionId), params.options ?? {});
    case "recordExecutorResult":
      return workRuntime.recordExecutorResult(String(params.sessionId), params.result as never);
    case "runBackgroundExecutor":
      return workRuntime.runBackgroundExecutor(String(params.sessionId), params.request as never, createDefaultWorkerSpawner({ flowRoot: repoRoot }));
    case "autoFlowIssue":
      return workRuntime.autoFlowIssue(
        String(params.sessionId),
        createDefaultWorkerSpawner({ flowRoot: repoRoot }),
        params.options ?? {},
      );
    case "resetAutoflowState":
      return workRuntime.resetAutoflowState(String(params.sessionId), asStringArray(params.issueRefs));
    default:
      throw new Error(`Unknown workRuntime method: ${method}`);
  }
}

function publishMethodEvent(
  method: string,
  params: Record<string, unknown>,
  phase: "started" | "completed" | "failed",
  extra: Record<string, unknown> = {},
): void {
  if (!method || method === "inspectQueue" || method === "inspectDashboardQueue") return;
  const eventType = method === "autoFlowIssue" ? `autoflow.${phase}` : `work_runtime.${phase}`;
  events.publish(eventType, {
    method,
    sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
    issueRef: typeof params.issueRef === "string" ? params.issueRef : undefined,
    ...extra,
  });
}

function logSlowMethod(method: string, params: Record<string, unknown>, durationMs: number): void {
  if (!shouldPerfLog(durationMs, Number(process.env.FLOW_PERF_METHOD_THRESHOLD_MS ?? "2000"))) return;
  console.error(`[flow perf] work_runtime.${method || "unknown"} duration_ms=${durationMs} session=${safeLogValue(params.sessionId)} issue=${safeLogValue(params.issueRef)}`);
}

function shouldPerfLog(durationMs: number, thresholdMs: number): boolean {
  return process.env.FLOW_PERF_LOG === "1" || durationMs >= thresholdMs;
}

function safeLogValue(value: unknown): string {
  return typeof value === "string" && value ? value.replace(/[^a-zA-Z0-9._:-]/g, "_") : "-";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function createIssueTracker() {
  const issueTracker = flowConfig?.issueTracker;
  const type = configString(issueTracker, "type") ?? "jira";
  if (type === "github" || type === "github_issues") {
    return new GhGitHubIssueTrackerAdapter({
      cwd: repoRoot,
      owner: configString(issueTracker, "owner") ?? configString(flowConfig?.collaboration, "owner"),
      repo: configString(issueTracker, "repo") ?? configString(flowConfig?.collaboration, "repo") ?? "flow",
      assignee: configString(issueTracker, "assignee"),
      activeLabels: configStringArray(issueTracker, "activeLabels"),
      backlogLabels: configStringArray(issueTracker, "backlogLabels"),
    });
  }
  return new AcliJiraAdapter({
    cwd: repoRoot,
    siteUrl: configString(issueTracker, "siteUrl"),
    projectKey: configString(issueTracker, "projectKey"),
  });
}

function configString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function configStringArray(config: Record<string, unknown> | undefined, key: string): string[] {
  const value = config?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function resolveRuntimeHost(config: FlowConfig | undefined): string {
  const host = config?.runtime?.workRuntime?.host?.trim();
  if (!host) {
    throw new Error("Missing required config value: runtime.workRuntime.host");
  }
  return host;
}

function resolveRuntimePort(config: FlowConfig | undefined): number {
  const port = config?.runtime?.workRuntime?.port;
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Missing required config value: runtime.workRuntime.port");
  }
  return port;
}
