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
  loadFlowConfig,
  type CreateIssueOptions,
  type WorkItem,
} from "./index.js";
import { GhGitHubIssueTrackerAdapter } from "./adapters/github.js";
import { loadFlowEnv, repoRoot } from "./flow-runtime.js";

loadFlowEnv();

const defaultSessionId = process.env.FLOW_SESSION_ID ?? "cli";
const cliCommands = [
  "commands",
  "session",
  "queue",
  "backlog",
  "select",
  "create-issue",
  "advance",
  "autoflow",
  "doctor",
  "handoff",
  "observe",
  "call",
];
const cliCommandDescriptions = {
  commands: "Describe the CLI command surface and raw Work Runtime call methods.",
  session: "Create or overwrite a named Work Runtime session.",
  queue: "Inspect current configured issue queue.",
  backlog: "Inspect configured issue backlog.",
  select: "Select an existing issue in a file-backed Work Runtime session.",
  "create-issue": "Create an issue through the configured issue tracker, store it in Flow, and select it by default.",
  advance: "Advance a selected issue, or select the issue first when provided.",
  autoflow: "Run deterministic autoflow for an issue.",
  doctor: "Diagnose Flow visibility, routing, PR state, readiness blockers, and next action.",
  handoff: "Summarize current session handoff state.",
  observe: "Observe projected workflow state for a subject.",
  call: "Call a supported Work Runtime method with raw JSON params.",
} satisfies Record<string, string>;
const rawWorkRuntimeMethods = [
  "inspectDashboardQueue",
  "inspectQueue",
  "inspectBacklog",
  "createSession",
  "selectIssue",
  "createIssue",
  "bootstrapIssue",
  "bootstrapJiraIssue",
  "createJiraIssue",
  "routeIssue",
  "prepareWorkspace",
  "advanceIssue",
  "diagnoseIssue",
  "autoFlowIssue",
  "resetAutoflowState",
  "refreshReviewState",
  "summarizeHandoff",
  "observeFlowSubject",
];
const flowConfig = await loadFlowConfig({ projectRoot: repoRoot });
const runtime = new FlowWorkRuntime({
  store: new FlowStore({ root: join(repoRoot, ".context", "flow", "runtime") }),
  ledger: createWorkflowLedger({ cwd: repoRoot }),
  github: new GhGitHubAdapter({ cwd: repoRoot, owner: configString(flowConfig?.collaboration, "owner") }),
  issueTracker: createIssueTracker(),
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
      commands: cliCommands,
      hint: "Run `flow commands` for descriptions, examples, and raw Work Runtime methods.",
    });
    process.exitCode = 1;
  });

program
  .command("commands")
  .description("Emit supported agent protocol commands.")
  .action(() => writeJson({
    commands: cliCommands.filter((command) => command !== "commands"),
    descriptions: cliCommandDescriptions,
    rawWorkRuntimeMethods,
    examples: [
      "flow queue",
      "flow create-issue --type Bug --summary \"Fix provider parquet schema\" --description \"Follow-up from ISSUE-15461.\" --repo app_api",
      "flow call createIssue '{\"options\":{\"issueType\":\"Bug\",\"summary\":\"Fix provider parquet schema\",\"repoKeys\":[\"app_api\"]}}'",
      "flow call routeIssue '{\"issueRef\":\"ISSUE-123\",\"repoKeys\":[\"app_api\"]}'",
      "flow advance ISSUE-123 --session codex-issue-123",
    ],
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
  .description("Inspect current configured issue queue.")
  .option("-l, --limit <count>", "issue limit", parsePositiveInteger, 10)
  .action(async (options: { limit: number }) => writeJson(await runtime.inspectQueue(options.limit)));

program
  .command("backlog")
  .description("Inspect configured issue backlog.")
  .option("-l, --limit <count>", "issue limit", parsePositiveInteger, 10)
  .action(async (options: { limit: number }) => writeJson(await runtime.inspectBacklog(options.limit)));

program
  .command("select")
  .description("Select an issue in a file-backed Work Runtime session.")
  .argument("<issue-ref>", "issue key or ref")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .action(async (issueRef: string, options: { session: string }) => {
    await ensureSession(options.session);
    writeJson(await runtime.selectIssue(options.session, await queueIssue(issueRef)));
  });

program
  .command("create-issue")
  .description("Create an issue through the configured issue tracker and select it by default.")
  .requiredOption("--summary <text>", "issue summary")
  .option("--description <text>", "issue description")
  .option("--type <type>", "issue type: Bug, Task, or Story", "Bug")
  .option("--project <key>", "issue tracker project key")
  .option("--repo <keys>", "comma-separated routed repo keys")
  .option("--branch-kind <kind>", "Flow branch kind: bug or feature")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .option("--no-select", "create and store the issue without selecting it")
  .action(async (options: {
    summary: string;
    description?: string;
    type: "Bug" | "Task" | "Story";
    project?: string;
    repo?: string;
    branchKind?: "bug" | "feature";
    session: string;
    select: boolean;
  }) => {
    await ensureSession(options.session);
    writeJson(await runtime.createIssue(options.session, {
      projectKey: options.project,
      issueType: parseJiraIssueType(options.type),
      branchKind: parseBranchKind(options.branchKind),
      summary: options.summary,
      description: options.description,
      repoKeys: asStringArray(options.repo),
      select: options.select,
    }));
  });

program
  .command("advance")
  .description("Advance a selected issue, or select the issue first when provided.")
  .argument("[issue-ref]", "issue key or ref")
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
  .argument("<issue-ref>", "issue key or ref")
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
  .argument("[issue-ref]", "issue key or ref")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .action(async (issueRef: string | undefined, options: { session: string }) => {
    await ensureSession(options.session);
    const issue = issueRef ? await queueIssue(issueRef) : undefined;
    if (issue) await runtime.selectIssue(options.session, issue);
    writeJson(await runtime.diagnoseIssue(options.session, issue?.ref));
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
  .description("Observe projected workflow state for a subject.")
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
  const resolvedIssueRef = await resolveIssueRef(issueRef);
  if (resolvedIssueRef) issueRef = resolvedIssueRef;
  const issueKey = issueRef.toUpperCase();
  const queue = await runtime.inspectQueue(50);
  const issue = queue.find((candidate) =>
    candidate.ref.toUpperCase() === issueKey || issueMatchesPullRequest(candidate, issueRef)
  );
  if (issue) return issue;
  return { ref: issueKey, title: issueKey, repoKeys: [], state: "queued", metadata: {} };
}

async function resolveIssueRef(ref: string): Promise<string | undefined> {
  const pullRequest = parsePullRequestRef(ref);
  if (!pullRequest) return undefined;

  const queueMatch = (await runtime.inspectQueue(50)).find((issue) => issueMatchesPullRequest(issue, ref));
  if (queueMatch) return queueMatch.ref;

  const pr = await runtimeGithubPullRequest(pullRequest.repo, pullRequest.number);
  return pr ? extractIssueRef([pr.title, pr.body, pr.headRefName, pr.url]) : undefined;
}

async function runtimeGithubPullRequest(repo: string, number: number) {
  try {
    return await runtimeGithub().getPullRequest(repo, number);
  } catch {
    return undefined;
  }
}

function runtimeGithub(): GhGitHubAdapter {
  return new GhGitHubAdapter({ cwd: repoRoot, owner: configString(flowConfig?.collaboration, "owner") });
}

function parsePullRequestRef(ref: string): { repo: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(ref.trim());
  if (!match) return undefined;
  return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

function issueMatchesPullRequest(issue: WorkItem, ref: string): boolean {
  const normalized = ref.trim();
  if (!normalized) return false;
  const metadata = issue.metadata ?? {};
  if (metadata.prUrl === normalized) return true;
  return Object.entries(metadata).some(([key, value]) =>
    key.endsWith(".pr_url") && value === normalized
  );
}

function extractIssueRef(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const match = /(?:^|[^A-Z0-9])([A-Z][A-Z0-9]+-\d+)(?=$|[^A-Z0-9])/i.exec(value ?? "");
    if (match) return match[1].toUpperCase();
  }
  return undefined;
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
    case "bootstrapIssue":
      return runtime.bootstrapJiraIssue(
        String(params.sessionId ?? defaultSessionId),
        String(params.issueRef),
        params.options ?? {},
      );
    case "createIssue":
      return runtime.createIssue(
        String(params.sessionId ?? defaultSessionId),
        params.options as CreateIssueOptions,
      );
    case "createJiraIssue":
      return runtime.createJiraIssue(
        String(params.sessionId ?? defaultSessionId),
        params.options as CreateIssueOptions,
      );
    case "routeIssue":
      return runtime.routeIssue(
        String(params.sessionId ?? defaultSessionId),
        String(params.issueRef),
        asStringArray(params.repoKeys) ?? [],
      );
    case "prepareWorkspace":
      return runtime.prepareWorkspace(
        String(params.sessionId ?? defaultSessionId),
        String(params.issueRef),
        params.options ?? {},
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
    case "refreshReviewState":
      return runtime.refreshReviewState(
        String(params.sessionId ?? defaultSessionId),
        String(params.issueRef),
      );
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

function parseJiraIssueType(value: string): "Bug" | "Task" | "Story" {
  if (value === "Bug" || value === "Task" || value === "Story") return value;
  throw new Error(`Expected issue type Bug, Task, or Story, got ${value}.`);
}

function parseBranchKind(value: string | undefined): "bug" | "feature" | undefined {
  if (value === undefined) return undefined;
  if (value === "bug" || value === "feature") return value;
  throw new Error(`Expected branch kind bug or feature, got ${value}.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
