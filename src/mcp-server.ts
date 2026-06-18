import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import { GhGitHubAdapter } from "./adapters/github.js";
import { bootstrapFlowConfig, loadFlowConfig, migrateFlowConfig, updateFlowConfig, validateFlowConfig } from "./config/config-loader.js";
import { resolveHostMediatedDirective } from "./config/host-mediated.js";
import { terminalWorkerStatusValues, workerExecutorValues, type WorkerStatus } from "./contracts/executor.js";
import type { AcceptanceCriterionEvidence, WorkItem } from "./contracts.js";
import { flowConfigPath, flowLayout } from "./flow-layout.js";
import { repoRoot as defaultRepoRoot } from "./flow-runtime.js";
import { FlowMcpProjectRegistry, type FlowMcpProjectRecord } from "./mcp-project-registry.js";
import { resolveFlowIssue } from "./issue-resolver.js";
import { createConfiguredWorkRuntime } from "./runtime-factory.js";
import { listOkfBundles, okfStatus, resolveOkfBundle, validateOkfBundle } from "./okf.js";
import type { FlowWorkRuntime } from "./work-runtime.js";

export interface FlowMcpServerOptions {
  projectRoot?: string;
  defaultSessionId?: string;
  projectRegistryPath?: string;
}

type ConfiguredRuntime = ReturnType<typeof createConfiguredWorkRuntime>;

interface FlowMcpContext {
  projectRoot: string;
  defaultSessionId: string;
  runtime: FlowWorkRuntime;
  workflowLedger: ConfiguredRuntime["workflowLedger"];
  workflowLedgerPath: string;
  flowConfig: ConfiguredRuntime["flowConfig"];
}

const optionalSessionSchema = {
  sessionId: z.string().optional().describe("Flow session id. Defaults to runtime.defaultSessionId or mcp."),
};
const projectScopeSchema = {
  projectId: z.string().optional().describe("Registered Flow project id. Defaults to the MCP server's default project."),
  projectRoot: z.string().optional().describe("Flow project root. Registers the project if it is not known yet."),
};
const projectReadScopeSchema = {
  ...projectScopeSchema,
  allProjects: z.boolean().optional().describe("Read across all registered Flow projects."),
};
const issueRefSchema = z.string().min(1).describe("Issue or work item reference, for example GH-123.");
const issueTypeSchema = z.enum(["Bug", "Task", "Story"]);
const branchKindSchema = z.enum(["bug", "feature"]);
const workerStatusSchema = z.enum(terminalWorkerStatusValues);
const workerExecutorSchema = z.enum(workerExecutorValues);
const okfKnowledgeDispositionSchema = z.enum(["updated", "not_needed", "needed", "drift_recorded", "validated"]);

export async function createFlowMcpServer(options: FlowMcpServerOptions = {}): Promise<McpServer> {
  const projectManager = new FlowMcpProjectManager(options);
  await projectManager.initialize();
  const server = new McpServer({ name: "flow", version: "0.3.0" });

  registerProjectTools(server, projectManager);
  registerReadTools(server, projectManager);
  registerIssueTools(server, projectManager);
  registerWorkflowTools(server, projectManager);
  registerReviewTools(server, projectManager);
  registerWorkJobTools(server, projectManager);
  registerKnowledgeTools(server, projectManager);

  return server;
}

export async function startFlowMcpServer(options: FlowMcpServerOptions = {}): Promise<void> {
  const server = await createFlowMcpServer(options);
  await server.connect(new StdioServerTransport());
}

class FlowMcpProjectManager {
  private readonly registry: FlowMcpProjectRegistry;
  private readonly defaultProjectRoot: string;
  private readonly defaultSessionId?: string;
  private readonly contexts = new Map<string, Promise<FlowMcpContext>>();

  constructor(options: FlowMcpServerOptions) {
    this.registry = new FlowMcpProjectRegistry({ statePath: options.projectRegistryPath });
    this.defaultProjectRoot = options.projectRoot ?? defaultRepoRoot;
    this.defaultSessionId = options.defaultSessionId;
  }

  async initialize(): Promise<void> {
    await this.registry.addProject(this.defaultProjectRoot, { makeDefault: true });
  }

  async projectList(): Promise<{ defaultProjectId?: string; defaultProject?: FlowMcpProjectRecord; projects: FlowMcpProjectRecord[] }> {
    const defaultProject = await this.defaultProject();
    return {
      defaultProjectId: defaultProject?.id,
      defaultProject,
      projects: await this.registry.listProjects(),
    };
  }

  async defaultProject(): Promise<FlowMcpProjectRecord> {
    return await this.registry.defaultProject()
      ?? await this.registry.addProject(this.defaultProjectRoot, { makeDefault: true });
  }

  async addProject(root: string, makeDefault = false): Promise<{ project: FlowMcpProjectRecord; context: FlowMcpContext }> {
    const project = await this.registry.addProject(root, { makeDefault });
    this.contexts.delete(project.id);
    return { project, context: await this.contextForProject(project) };
  }

  async resolveProject(input: { projectId?: string; projectRoot?: string } = {}): Promise<{ project: FlowMcpProjectRecord; context: FlowMcpContext }> {
    let project = input.projectId || input.projectRoot
      ? await this.registry.getProject({ projectId: input.projectId, root: input.projectRoot })
      : await this.defaultProject();
    if (!project && input.projectRoot) {
      project = await this.registry.addProject(input.projectRoot);
    }
    if (!project) throw new Error("Unknown Flow project. Pass projectId, projectRoot, or register the project with flow_project_add.");
    return { project, context: await this.contextForProject(project) };
  }

  async refreshProject(input: { projectId?: string; projectRoot?: string } = {}): Promise<{ project: FlowMcpProjectRecord; context: FlowMcpContext }> {
    const { project } = await this.resolveProject(input);
    const refreshed = await this.registry.refreshProject(project.id);
    this.contexts.delete(refreshed.id);
    return { project: refreshed, context: await this.contextForProject(refreshed) };
  }

  async removeProject(projectId: string): Promise<void> {
    await this.registry.removeProject(projectId);
    this.contexts.delete(projectId);
  }

  async projectContexts(): Promise<Array<{ project: FlowMcpProjectRecord; context: FlowMcpContext }>> {
    const projects = await this.registry.listProjects();
    return Promise.all(projects.map(async (project) => ({ project, context: await this.contextForProject(project) })));
  }

  private contextForProject(project: FlowMcpProjectRecord): Promise<FlowMcpContext> {
    const cached = this.contexts.get(project.id);
    if (cached) return cached;
    const created = createFlowMcpContext({
      projectRoot: project.root,
      defaultSessionId: this.defaultSessionId,
    });
    this.contexts.set(project.id, created);
    return created;
  }
}

async function createFlowMcpContext(options: FlowMcpServerOptions): Promise<FlowMcpContext> {
  const projectRoot = options.projectRoot ?? defaultRepoRoot;
  const configValidation = await validateFlowConfig({ projectRoot });
  const configuredRuntime = createConfiguredWorkRuntime({ projectRoot, flowConfig: configValidation.config });
  return {
    projectRoot,
    defaultSessionId: options.defaultSessionId
      ?? configString(configValidation.config?.runtime, "defaultSessionId")
      ?? "mcp",
    runtime: configuredRuntime.runtime,
    workflowLedger: configuredRuntime.workflowLedger,
    workflowLedgerPath: configuredRuntime.workflowLedgerPath,
    flowConfig: configuredRuntime.flowConfig,
  };
}

function registerProjectTools(
  server: McpServer,
  projectManager: FlowMcpProjectManager,
): void {
  server.registerTool("flow_projects", {
    description: "List Flow projects registered with this MCP server.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => result(await projectManager.projectList()));

  server.registerTool("flow_project_add", {
    description: "Add a project root to this MCP server's project registry.",
    inputSchema: {
      root: z.string().min(1),
      makeDefault: z.boolean().optional(),
    },
  }, async ({ root, makeDefault }) => {
    const added = await projectManager.addProject(root, makeDefault === true);
    return result({
      project: added.project,
      ...(await projectManager.projectList()),
    });
  });

  server.registerTool("flow_project_refresh", {
    description: "Refresh project registry metadata from a project's Flow config.",
    inputSchema: projectScopeSchema,
  }, async ({ projectId, projectRoot }) => {
    const refreshed = await projectManager.refreshProject({ projectId, projectRoot });
    return result({
      project: refreshed.project,
      ...(await projectManager.projectList()),
    });
  });

  server.registerTool("flow_project_remove", {
    description: "Remove a project from this MCP server's project registry.",
    inputSchema: { projectId: z.string().min(1) },
  }, async ({ projectId }) => {
    await projectManager.removeProject(projectId);
    return result(await projectManager.projectList());
  });
}

function registerReadTools(server: McpServer, projectManager: FlowMcpProjectManager): void {
  server.registerTool("flow_state", {
    description: "Read the current Flow handoff state for a session.",
    inputSchema: { ...optionalSessionSchema, ...projectScopeSchema },
    annotations: { readOnlyHint: true },
  }, async ({ sessionId, projectId, projectRoot }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    withSession(context, sessionId, (activeSessionId) => context.runtime.summarizeHandoff(activeSessionId))
  )));

  server.registerTool("flow_queue", {
    description: "Inspect active configured-tracker work.",
    inputSchema: { ...projectReadScopeSchema, limit: z.number().int().positive().optional() },
    annotations: { readOnlyHint: true },
  }, async (input) => result(await readProjectWorkItems(projectManager, input, (context, limit) =>
    context.runtime.inspectQueue(limit)
  )));

  server.registerTool("flow_backlog", {
    description: "Inspect backlog work.",
    inputSchema: { ...projectReadScopeSchema, limit: z.number().int().positive().optional() },
    annotations: { readOnlyHint: true },
  }, async (input) => result(await readProjectWorkItems(projectManager, input, (context, limit) =>
    context.runtime.inspectBacklog(limit)
  )));

  server.registerTool("flow_bootstrap", {
    description: "Create Flow config from repository metadata.",
    inputSchema: {
      ...projectScopeSchema,
      force: z.boolean().optional(),
    },
  }, async ({ projectId, projectRoot, force }) => {
    const { project, context } = await projectManager.resolveProject({ projectId, projectRoot });
    const bootstrap = await bootstrapFlowConfig({
      projectRoot: context.projectRoot,
      force,
    });
    const refreshed = await projectManager.refreshProject({ projectId: project.id });
    return result({ ...bootstrap, project: refreshed.project });
  });

  server.registerTool("flow_config_get", {
    description: "Read the Flow-managed config for a project.",
    inputSchema: projectScopeSchema,
    annotations: { readOnlyHint: true },
  }, async ({ projectId, projectRoot }) => result(await withProject(projectManager, { projectId, projectRoot }, async (context) => ({
    path: flowConfigPath(context.projectRoot),
    config: await loadFlowConfig({ projectRoot: context.projectRoot }),
  }))));

  server.registerTool("flow_config_update", {
    description: "Update Flow-managed project config with a schema-validated patch.",
    inputSchema: {
      ...projectScopeSchema,
      patch: z.record(z.string(), z.unknown()),
    },
  }, async ({ projectId, projectRoot, patch }) => {
    const { project, context } = await projectManager.resolveProject({ projectId, projectRoot });
    const updated = await updateFlowConfig({ projectRoot: context.projectRoot, patch });
    const refreshed = await projectManager.refreshProject({ projectId: project.id });
    const { config: _config, ...publicResult } = updated;
    return result({ ...publicResult, project: refreshed.project });
  });

  server.registerTool("flow_config_validate", {
    description: "Validate Flow config.",
    inputSchema: projectScopeSchema,
    annotations: { readOnlyHint: true },
  }, async ({ projectId, projectRoot }) => {
    const { context } = await projectManager.resolveProject({ projectId, projectRoot });
    const { config: _config, ...publicResult } = await validateFlowConfig({
      projectRoot: context.projectRoot,
    });
    return result(publicResult);
  });

  server.registerTool("flow_config_explain", {
    description: "Explain configured topology, adapters, and runtime settings.",
    inputSchema: projectScopeSchema,
    annotations: { readOnlyHint: true },
  }, async ({ projectId, projectRoot }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    explainConfig(context.projectRoot)
  )));

  server.registerTool("flow_delegate", {
    description: "Resolve the concrete host-mediated tool call for an issue-tracker operation (when issueTracker.type is \"host-mediated\"). Returns { binding, operation, tool, args }: invoke that MCP tool via your own connection, then report the result back with flow_record_* tools.",
    inputSchema: {
      ...projectReadScopeSchema,
      operation: z.string().min(1).describe("view | fetchQueue | fetchBacklog | search | transition | comment | create | tag"),
      ref: z.string().optional().describe("Issue ref, e.g. PRO-3378."),
      status: z.string().optional().describe("Target normalized status; resolved to a provider state id via issueTracker.statusMap."),
      body: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ projectId, projectRoot, operation, ref, status, body, title, description, query, limit }) =>
    result(await withProject(projectManager, { projectId, projectRoot }, async (context) =>
      resolveHostMediatedDirective(context.flowConfig, operation, { ref, status, body, title, description, query, limit }),
    )));

  server.registerTool("flow_config_migrate", {
    description: "Report or apply Flow config migration.",
    inputSchema: {
      ...projectScopeSchema,
      write: z.boolean().optional(),
    },
  }, async ({ projectId, projectRoot, write }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    migrateFlowConfig({
      projectRoot: context.projectRoot,
      write: write === true,
    })
  )));

  server.registerTool("flow_ledger_verify", {
    description: "Verify the configured workflow ledger.",
    inputSchema: projectScopeSchema,
    annotations: { readOnlyHint: true },
  }, async ({ projectId, projectRoot }) => withProject(projectManager, { projectId, projectRoot }, async (context) => {
    const issues = await context.workflowLedger.listIssues(1);
    return result({
      ok: true,
      backend: context.workflowLedgerPath === "<postgres>" ? "postgres" : "sqlite",
      path: context.workflowLedgerPath,
      sampleIssueCount: issues.length,
    });
  }));

  server.registerTool("flow_layout", {
    description: "Read Flow's configured file and directory layout.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => result(flowLayout));
}

function registerIssueTools(server: McpServer, projectManager: FlowMcpProjectManager): void {
  server.registerTool("flow_issue_view", {
    description: "Inspect an issue or work item by reference.",
    inputSchema: { ...projectScopeSchema, id: issueRefSchema },
    annotations: { readOnlyHint: true },
  }, async ({ projectId, projectRoot, id }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    context.runtime.inspectIssue(id)
  )));

  server.registerTool("flow_issue_select", {
    description: "Select an issue in a Flow session.",
    inputSchema: { ...optionalSessionSchema, ...projectScopeSchema, id: issueRefSchema },
  }, async ({ sessionId, projectId, projectRoot, id }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    withSession(context, sessionId, async (activeSessionId) =>
      context.runtime.selectIssue(activeSessionId, await resolveIssue(context, id))
    )
  )));

  server.registerTool("flow_issue_intake", {
    description: "Analyze issue creation input and optionally prepare or apply tracked work.",
    inputSchema: createIssueInputSchema({
      apply: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      review: z.boolean().optional(),
    }),
  }, async (rawInput) => {
    const input = rawInput as IssueIntakeToolInput;
    return result(await withProject(projectManager, input, (context) =>
      withSession(context, input.sessionId, (activeSessionId) =>
        context.runtime.intakeIssue(activeSessionId, {
          projectKey: input.projectKey,
          issueType: input.issueType ?? "Bug",
          branchKind: input.branchKind,
          title: input.title,
          summary: input.summary,
          description: input.description,
          repoKeys: input.repoKeys,
          select: input.select,
          apply: input.apply === true,
          dryRun: input.apply === true ? false : input.dryRun !== false,
          review: input.review === true,
        })
      )
    ));
  });

  server.registerTool("flow_issue_create", {
    description: "Create tracked work through the configured issue tracker.",
    inputSchema: createIssueInputSchema({
      ref: z.string().min(1).optional(),
    }),
  }, async (rawInput) => {
    const input = rawInput as IssueCreateToolInput & { ref?: string };
    return result(await withProject(projectManager, input, (context) =>
      withSession(context, input.sessionId, (activeSessionId) =>
        context.runtime.createIssue(activeSessionId, {
          projectKey: input.projectKey,
          issueType: input.issueType ?? "Bug",
          branchKind: input.branchKind,
          title: input.title,
          summary: input.summary,
          description: input.description,
          repoKeys: input.repoKeys,
          select: input.select,
          ref: input.ref,
        })
      )
    ));
  });

  server.registerTool("flow_issue_route", {
    description: "Record the repos an issue should touch.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      repoKeys: z.array(z.string().min(1)).optional(),
    },
  }, async ({ sessionId, projectId, projectRoot, id, repoKeys }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    withSession(context, sessionId, (activeSessionId) =>
      context.runtime.routeIssue(activeSessionId, id, repoKeys ?? [])
    )
  )));

  server.registerTool("flow_issue_triage", {
    description: "Analyze open issues and propose cleanup actions.",
    inputSchema: {
      ...projectScopeSchema,
      apply: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
      ids: z.array(z.string().min(1)).optional(),
    },
  }, async ({ projectId, projectRoot, apply, limit, ids }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    context.runtime.triageIssues({
      dryRun: apply === true ? false : true,
      apply: apply === true,
      limit,
      ids,
    })
  )));

  server.registerTool("flow_prepare_workspace", {
    description: "Prepare the git worktree for an issue.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      repoKey: z.string().optional(),
      baseBranch: z.string().optional(),
    },
  }, async ({ sessionId, projectId, projectRoot, id, repoKey, baseBranch }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    withSession(context, sessionId, (activeSessionId) =>
      context.runtime.prepareWorkspace(activeSessionId, id, { repoKey, baseBranch })
    )
  )));

  server.registerTool("flow_adopt_workspace", {
    description: "Record an existing worktree as the workspace for an issue.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      repoKey: z.string().optional(),
      worktreePath: z.string().min(1),
      baseBranch: z.string().optional(),
    },
  }, async ({ sessionId, projectId, projectRoot, id, repoKey, worktreePath, baseBranch }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    withSession(context, sessionId, (activeSessionId) =>
      context.runtime.adoptWorkspace(activeSessionId, id, { repoKey, worktreePath, baseBranch })
    )
  )));

  server.registerTool("flow_adopt_branch", {
    description: "Adopt current local branch/worktree as Flow-tracked work.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      issueRef: z.string().optional(),
      summary: z.string().optional(),
      description: z.string().optional(),
      repoKey: z.string().optional(),
      worktreePath: z.string().optional(),
      baseBranch: z.string().optional(),
      prefix: z.string().optional(),
      select: z.boolean().optional(),
    },
  }, async (input) => result(await withProject(projectManager, input, (context) =>
    withSession(context, input.sessionId, (activeSessionId) =>
      context.runtime.adoptBranch(activeSessionId, {
        issueRef: input.issueRef,
        summary: input.summary,
        description: input.description,
        repoKey: input.repoKey,
        worktreePath: input.worktreePath,
        baseBranch: input.baseBranch,
        prefix: input.prefix ?? configString(context.flowConfig?.issueTracker, "prefix") ?? "FLOW",
        select: input.select,
      })
    )
  )));
}

function registerWorkflowTools(server: McpServer, projectManager: FlowMcpProjectManager): void {
  server.registerTool("flow_workflow_advance", {
    description: "Advance selected issue workflow state.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      approveConfirmationId: z.string().optional(),
    },
  }, async ({ sessionId, projectId, projectRoot, id, approveConfirmationId }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    selectThen(context, sessionId, id, (activeSessionId) =>
      context.runtime.advanceIssue(activeSessionId, approveConfirmationId)
    )
  )));

  server.registerTool("flow_workflow_audit", {
    description: "Diagnose workflow readiness for an issue.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      strict: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ sessionId, projectId, projectRoot, id, strict }) => {
    const diagnosis = await withProject(projectManager, { projectId, projectRoot }, (context) =>
      withSession(context, sessionId, (activeSessionId) =>
        context.runtime.diagnoseIssue(activeSessionId, id)
      )
    );
    if (strict === true && doctorStrictFailure(diagnosis)) {
      throw new Error(`Flow doctor reported ${diagnosis.status} status for ${diagnosis.issueRef}.`);
    }
    return result(diagnosis);
  });

  server.registerTool("flow_workflow_handoff", {
    description: "Summarize current Flow handoff state.",
    inputSchema: { ...optionalSessionSchema, ...projectScopeSchema },
    annotations: { readOnlyHint: true },
  }, async ({ sessionId, projectId, projectRoot }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    withSession(context, sessionId, (activeSessionId) =>
      context.runtime.summarizeHandoff(activeSessionId)
    )
  )));

  server.registerTool("flow_workflow_adopt_handoff", {
    description: "Adopt a pending local-thread handoff request.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      adopter: z.string().optional(),
      summary: z.string().optional(),
    },
  }, async ({ sessionId, projectId, projectRoot, id, adopter, summary }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    selectThen(context, sessionId, id, (activeSessionId) =>
      context.runtime.adoptPendingLocalThread(activeSessionId, { adopter, summary })
    )
  )));

  server.registerTool("flow_publish_workspace", {
    description: "Push the prepared worktree branch.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      repoKey: z.string().optional(),
      force: z.boolean().optional(),
    },
  }, async ({ sessionId, projectId, projectRoot, id, repoKey, force }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    selectThen(context, sessionId, id, (activeSessionId) =>
      context.runtime.publishWorkspace(activeSessionId, { issueRef: id, repoKey, force: force === true })
    )
  )));

  server.registerTool("flow_open_pull_request", {
    description: "Create a pull request through the configured collaboration provider and record it.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      repoKey: z.string().optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      draft: z.boolean().optional(),
      baseBranch: z.string().optional(),
    },
  }, async (input) => result(await withProject(projectManager, input, (context) =>
    selectThen(context, input.sessionId, input.id, (activeSessionId) =>
      context.runtime.openPullRequest(activeSessionId, {
        issueRef: input.id,
        repoKey: input.repoKey,
        title: input.title,
        body: input.body,
        draft: input.draft === true,
        baseBranch: input.baseBranch,
      })
    )
  )));

  server.registerTool("flow_sync_branch", {
    description: "Rebase the prepared branch onto its base and refresh review state.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      repoKey: z.string().optional(),
      push: z.boolean().optional(),
    },
  }, async ({ sessionId, projectId, projectRoot, id, repoKey, push }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    selectThen(context, sessionId, id, (activeSessionId) =>
      context.runtime.syncWorkspaceBranch(activeSessionId, { issueRef: id, repoKey, push: push !== false })
    )
  )));

  server.registerTool("flow_cleanup_workspaces", {
    description: "Prune merged issue worktrees.",
    inputSchema: { ...optionalSessionSchema, ...projectScopeSchema, id: issueRefSchema },
  }, async ({ sessionId, projectId, projectRoot, id }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    selectThen(context, sessionId, id, (activeSessionId) =>
      context.runtime.cleanupIssueWorkspaces(activeSessionId, id)
    )
  )));

  server.registerTool("flow_record_result", {
    description: "Record local thread or executor result for an issue.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      repoKey: z.string().optional(),
      taskId: z.string().optional(),
      workJobId: z.string().optional(),
      status: workerStatusSchema.optional(),
      summary: z.string().min(1),
      changedFiles: z.array(z.string()).optional(),
      testsRun: z.array(z.string()).optional(),
      blockers: z.array(z.string()).optional(),
      nextPickup: z.string().optional(),
      handoffPrompt: z.string().optional(),
      evidenceCandidate: z.string().optional(),
    },
  }, async (input) => result(await withProject(projectManager, input, (context) =>
    selectThen(context, input.sessionId, input.id, (activeSessionId) =>
      context.runtime.recordLocalThreadResult(activeSessionId, {
        issueRef: input.id,
        repoKey: input.repoKey,
        taskId: input.taskId,
        workJobId: input.workJobId,
        status: parseWorkerResultStatus(input.status ?? "succeeded"),
        summary: input.summary,
        changedFiles: input.changedFiles,
        testsRun: input.testsRun,
        blockers: input.blockers,
        nextPickup: input.nextPickup,
        handoffPrompt: input.handoffPrompt,
        evidenceCandidate: input.evidenceCandidate,
      })
    )
  )));

  server.registerTool("flow_record_pull_request", {
    description: "Record pull request metadata for an issue.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      repo: z.string().min(1),
      number: z.number().int().positive(),
      url: z.string().min(1),
      headRefName: z.string().optional(),
      isDraft: z.boolean().optional(),
      checksPassing: z.boolean().optional(),
      checksPending: z.boolean().optional(),
      reviewDecision: z.string().optional(),
    },
  }, async (input) => result(await withProject(projectManager, input, (context) =>
    selectThen(context, input.sessionId, input.id, (activeSessionId) =>
      context.runtime.recordPullRequest(activeSessionId, {
        issueRef: input.id,
        repo: input.repo,
        number: input.number,
        url: input.url,
        headRefName: input.headRefName,
        isDraft: input.isDraft === true,
        checksPassing: input.checksPassing,
        checksPending: input.checksPending,
        reviewDecision: input.reviewDecision,
      })
    )
  )));

  server.registerTool("flow_record_evidence", {
    description: "Record evidence for an issue.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      summary: z.string().min(1),
      source: z.string().optional(),
      criteria: z.array(z.string()).optional(),
    },
  }, async ({ sessionId, projectId, projectRoot, id, summary, source, criteria }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    selectThen(context, sessionId, id, (activeSessionId) =>
      context.runtime.recordEvidence(activeSessionId, {
        issueRef: id,
        summary,
        source: source ?? "local",
        criteria: parseEvidenceCriteria(criteria, summary, source ?? "local"),
      })
    )
  )));

  server.registerTool("flow_record_documentation", {
    description: "Record documentation disposition for an issue.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      disposition: z.enum(["updated", "not_needed", "needed"]).optional(),
      summary: z.string().min(1),
    },
  }, async ({ sessionId, projectId, projectRoot, id, disposition, summary }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    selectThen(context, sessionId, id, (activeSessionId) =>
      context.runtime.recordDocumentation(activeSessionId, {
        issueRef: id,
        disposition: disposition ?? "not_needed",
        summary,
      })
    )
  )));

  server.registerTool("flow_record_acceptance", {
    description: "Record acceptance evidence and documentation disposition together.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      summary: z.string().optional(),
      evidenceSummary: z.string().optional(),
      source: z.string().optional(),
      criteria: z.array(z.string()).optional(),
      documentationSummary: z.string().optional(),
      disposition: z.enum(["updated", "not_needed", "needed"]).optional(),
    },
  }, async ({ sessionId, projectId, projectRoot, id, summary, evidenceSummary, source, criteria, documentationSummary, disposition }) => {
    const evidenceText = evidenceSummary ?? summary;
    const docsText = documentationSummary ?? summary;
    if (!evidenceText) throw new Error("flow_record_acceptance requires evidenceSummary or summary.");
    if (!docsText) throw new Error("flow_record_acceptance requires documentationSummary or summary.");
    return result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
      selectThen(context, sessionId, id, async (activeSessionId) => {
        const evidence = await context.runtime.recordEvidence(activeSessionId, {
          issueRef: id,
          summary: evidenceText,
          source: source ?? "local",
          criteria: parseEvidenceCriteria(criteria, evidenceText, source ?? "local"),
        });
        const documentation = await context.runtime.recordDocumentation(activeSessionId, {
          issueRef: id,
          disposition: disposition ?? "not_needed",
          summary: docsText,
        });
        return { evidence, documentation };
      })
    ));
  });

  server.registerTool("flow_observe", {
    description: "Observe issue workflow state and suggested next actions.",
    inputSchema: {
      ...projectScopeSchema,
      type: z.string().optional(),
      id: issueRefSchema,
    },
    annotations: { readOnlyHint: true },
  }, async ({ projectId, projectRoot, type, id }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    context.runtime.observeFlowSubject({ type: type ?? "issue", ref: id })
  )));
}

function registerReviewTools(server: McpServer, projectManager: FlowMcpProjectManager): void {
  server.registerTool("flow_review_local", {
    description: "Review local readiness state for an issue.",
    inputSchema: { ...optionalSessionSchema, ...projectScopeSchema, id: issueRefSchema },
    annotations: { readOnlyHint: true },
  }, async ({ sessionId, projectId, projectRoot, id }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    selectThen(context, sessionId, id, (activeSessionId) =>
      context.runtime.reviewLocal(activeSessionId, id)
    )
  )));

  server.registerTool("flow_review_code_review", {
    description: "Review external pull request/check/review state for an issue.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      repo: z.string().optional(),
      post: z.boolean().optional(),
    },
  }, async ({ sessionId, projectId, projectRoot, id, repo, post }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    selectThen(context, sessionId, id, (activeSessionId) =>
      context.runtime.reviewCodeReview(activeSessionId, id, { repo, post: post === true })
    )
  )));
}

function registerWorkJobTools(server: McpServer, projectManager: FlowMcpProjectManager): void {
  server.registerTool("flow_work_jobs", {
    description: "List typed work jobs for a session or issue.",
    inputSchema: { ...optionalSessionSchema, ...projectScopeSchema, issueRef: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ sessionId, projectId, projectRoot, issueRef }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    withSession(context, sessionId, (activeSessionId) =>
      context.runtime.listWorkJobs(activeSessionId, issueRef)
    )
  )));

  server.registerTool("flow_claim_work_job", {
    description: "Claim a typed work job for an executor.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      jobId: z.string().min(1),
      executor: workerExecutorSchema,
    },
  }, async ({ sessionId, projectId, projectRoot, jobId, executor }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    withSession(context, sessionId, (activeSessionId) =>
      context.runtime.claimWorkJob(activeSessionId, jobId, executor)
    )
  )));

  server.registerTool("flow_record_work_job_result", {
    description: "Record a typed work job result.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      jobId: z.string().min(1),
      issueRef: issueRefSchema,
      repoKey: z.string().min(1),
      workType: z.string().min(1),
      status: workerStatusSchema,
      summary: z.string().min(1),
      evidence: z.array(z.string()).optional(),
      completedAt: z.string().optional(),
    },
  }, async (input) => result(await withProject(projectManager, input, (context) =>
    withSession(context, input.sessionId, (activeSessionId) =>
      context.runtime.recordWorkJobResult(activeSessionId, {
        jobId: input.jobId,
        issueRef: input.issueRef,
        repoKey: input.repoKey,
        workType: input.workType,
        status: parseWorkerResultStatus(input.status),
        summary: input.summary,
        evidence: input.evidence ?? [],
        completedAt: input.completedAt ?? new Date().toISOString(),
      })
    )
  )));
}

function registerKnowledgeTools(server: McpServer, projectManager: FlowMcpProjectManager): void {
  server.registerTool("flow_okf_list", {
    description: "List OKF bundles configured or detected for a Flow project.",
    inputSchema: projectReadScopeSchema,
    annotations: { readOnlyHint: true },
  }, async (input) => result(await readProjectOkf(projectManager, input, async (context) => ({
    bundles: listOkfBundles(context.projectRoot, context.flowConfig),
  }))));

  server.registerTool("flow_okf_status", {
    description: "Validate configured or detected OKF bundles and summarize knowledge health.",
    inputSchema: projectReadScopeSchema,
    annotations: { readOnlyHint: true },
  }, async (input) => result(await readProjectOkf(projectManager, input, (context) =>
    okfStatus(context.projectRoot, context.flowConfig)
  )));

  server.registerTool("flow_okf_validate", {
    description: "Validate one OKF bundle against hard OKF conformance rules.",
    inputSchema: {
      ...projectScopeSchema,
      bundleId: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ projectId, projectRoot, bundleId, path }) => result(await withProject(projectManager, { projectId, projectRoot }, async (context) => {
    const bundle = resolveOkfBundle(context.projectRoot, context.flowConfig, { bundleId, path });
    return validateOkfBundle(bundle);
  })));

  server.registerTool("flow_okf_record_disposition", {
    description: "Record OKF or knowledge lifecycle disposition for an issue.",
    inputSchema: {
      ...optionalSessionSchema,
      ...projectScopeSchema,
      id: issueRefSchema,
      disposition: okfKnowledgeDispositionSchema,
      summary: z.string().min(1),
      bundleId: z.string().min(1).optional(),
      concept: z.string().min(1).optional(),
      source: z.string().min(1).optional(),
    },
  }, async ({ sessionId, projectId, projectRoot, id, disposition, summary, bundleId, concept, source }) => result(await withProject(projectManager, { projectId, projectRoot }, (context) =>
    selectThen(context, sessionId, id, (activeSessionId) =>
      context.runtime.recordKnowledgeDisposition(activeSessionId, {
        issueRef: id,
        disposition,
        summary,
        bundleId,
        concept,
        source,
      })
    )
  )));
}

async function withSession<T>(
  context: FlowMcpContext,
  sessionId: string | undefined,
  run: (activeSessionId: string) => Promise<T>,
): Promise<T> {
  const activeSessionId = sessionId ?? context.defaultSessionId;
  await ensureSession(context.runtime, activeSessionId);
  return run(activeSessionId);
}

type ProjectScopedInput = {
  projectId?: string;
  projectRoot?: string;
};

async function withProject<T>(
  projectManager: FlowMcpProjectManager,
  input: ProjectScopedInput,
  run: (context: FlowMcpContext) => Promise<T>,
): Promise<T> {
  const { context } = await projectManager.resolveProject(input);
  return run(context);
}

async function readProjectWorkItems(
  projectManager: FlowMcpProjectManager,
  input: ProjectScopedInput & { allProjects?: boolean; limit?: number },
  read: (context: FlowMcpContext, limit: number) => Promise<WorkItem[]>,
): Promise<WorkItem[] | { projects: Array<{ project: FlowMcpProjectRecord; value: WorkItem[] }>; value: Array<WorkItem & { projectId: string; projectRoot: string; projectName: string }> }> {
  const limit = input.limit ?? 10;
  if (input.allProjects === true) {
    const projects = await Promise.all((await projectManager.projectContexts()).map(async ({ project, context }) => ({
      project,
      value: await read(context, limit),
    })));
    return {
      projects,
      value: projects.flatMap(({ project, value }) => value.map((item) => ({
        ...item,
        projectId: project.id,
        projectRoot: project.root,
        projectName: project.name,
      }))),
    };
  }
  const { context } = await projectManager.resolveProject(input);
  return read(context, limit);
}

async function readProjectOkf<T extends object>(
  projectManager: FlowMcpProjectManager,
  input: ProjectScopedInput & { allProjects?: boolean },
  read: (context: FlowMcpContext) => Promise<T>,
): Promise<T | { projects: Array<{ project: FlowMcpProjectRecord; value: T }>; value: Array<T & { projectId: string; projectRoot: string; projectName: string }> }> {
  if (input.allProjects === true) {
    const projects = await Promise.all((await projectManager.projectContexts()).map(async ({ project, context }) => ({
      project,
      value: await read(context),
    })));
    return {
      projects,
      value: projects.map(({ project, value }) => ({
        ...value,
        projectId: project.id,
        projectRoot: project.root,
        projectName: project.name,
      })),
    };
  }
  const { context } = await projectManager.resolveProject(input);
  return read(context);
}

async function selectThen<T>(
  context: FlowMcpContext,
  sessionId: string | undefined,
  issueRef: string,
  run: (activeSessionId: string) => Promise<T>,
): Promise<T> {
  return withSession(context, sessionId, async (activeSessionId) => {
    await context.runtime.selectIssue(activeSessionId, await resolveIssue(context, issueRef));
    return run(activeSessionId);
  });
}

async function ensureSession(runtime: FlowWorkRuntime, sessionId: string): Promise<void> {
  try {
    await runtime.summarizeHandoff(sessionId);
  } catch {
    await runtime.createSession(sessionId);
  }
}

async function resolveIssue(context: FlowMcpContext, issueRef: string): Promise<WorkItem> {
  const resolvedIssueRef = await resolveIssueRef(context, issueRef);
  return resolveFlowIssue(context.runtime, resolvedIssueRef ?? issueRef, (candidate, ref) =>
    candidate.ref.toUpperCase() === ref.toUpperCase() || issueMatchesPullRequest(candidate, ref)
  );
}

async function resolveIssueRef(context: FlowMcpContext, ref: string): Promise<string | undefined> {
  const pullRequest = parsePullRequestRef(ref);
  if (!pullRequest) return undefined;

  const queueMatch = (await context.runtime.inspectQueue(50)).find((issue) => issueMatchesPullRequest(issue, ref));
  if (queueMatch) return queueMatch.ref;

  const pr = await new GhGitHubAdapter({
    cwd: context.projectRoot,
    owner: configString(context.flowConfig?.collaboration, "owner"),
  }).getPullRequest(pullRequest.repo, pullRequest.number).catch(() => undefined);
  return pr ? extractIssueRef([pr.title, pr.body, pr.headRefName, pr.url]) : undefined;
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

async function explainConfig(projectRoot: string, configPath?: string) {
  const result = await validateFlowConfig({ projectRoot, configPath });
  const config = result.config;
  return {
    ok: result.ok,
    path: result.path,
    errors: result.errors,
    project: config?.project,
    topology: config
      ? {
        repos: Object.fromEntries(Object.entries(config.topology.repos).map(([key, repo]) => [key, {
          name: repo.name,
          baseBranch: repo.baseBranch,
          pathFromRoot: repo.pathFromRoot,
        }])),
        branchPattern: config.topology.branchPattern,
        pullRequestUrlPattern: config.topology.pullRequestUrlPattern,
        issueInferenceRules: config.topology.issueInference.length,
      }
      : undefined,
    adapters: config
      ? {
        issueTracker: config.issueTracker?.type,
        collaboration: config.collaboration?.type,
        sourceControl: config.sourceControl?.type,
        ledger: config.ledger?.type,
      }
      : undefined,
    knowledge: config?.knowledge
      ? {
        okfBundles: config.knowledge.okfBundles.map((bundle) => ({
          id: bundle.id,
          path: bundle.path,
          description: bundle.description,
          owner: bundle.owner,
        })),
      }
      : undefined,
    runtime: config?.runtime
      ? {
        store: config.runtime.store,
        agentSession: config.runtime.agentSession,
        executionPlane: config.runtime.executionPlane
          ? {
            type: config.runtime.executionPlane.type,
            workerName: config.runtime.executionPlane.workerName,
            slots: config.runtime.executionPlane.slots,
            dashboardUrl: config.runtime.executionPlane.dashboardUrl,
          }
          : undefined,
        defaultSessionId: config.runtime.defaultSessionId,
        dashboard: config.runtime.dashboard
          ? {
            host: config.runtime.dashboard.host,
            port: config.runtime.dashboard.port,
            url: config.runtime.dashboard.url,
          }
          : undefined,
      }
      : undefined,
  };
}

function createIssueInputSchema<T extends Record<string, z.ZodType> = Record<string, never>>(extra?: T) {
  return {
    ...optionalSessionSchema,
    ...projectScopeSchema,
    projectKey: z.string().optional(),
    issueType: issueTypeSchema.optional(),
    branchKind: branchKindSchema.optional(),
    title: z.string().optional(),
    summary: z.string().min(1),
    description: z.string().optional(),
    repoKeys: z.array(z.string().min(1)).optional(),
    select: z.boolean().optional(),
    ...extra,
  };
}

type IssueCreateToolInput = {
  sessionId?: string;
  projectId?: string;
  projectRoot?: string;
  projectKey?: string;
  issueType?: "Bug" | "Task" | "Story";
  branchKind?: "bug" | "feature";
  title?: string;
  summary: string;
  description?: string;
  repoKeys?: string[];
  select?: boolean;
};

type IssueIntakeToolInput = IssueCreateToolInput & {
  apply?: boolean;
  dryRun?: boolean;
  review?: boolean;
};

type TerminalWorkerStatus = Extract<WorkerStatus, "succeeded" | "blocked" | "failed">;

function parseWorkerResultStatus(value: string): TerminalWorkerStatus {
  if ((terminalWorkerStatusValues as readonly string[]).includes(value)) return value as TerminalWorkerStatus;
  throw new Error(`Expected worker status ${terminalWorkerStatusValues.join(", ")}, got ${value}.`);
}

function parseEvidenceCriteria(
  value: string[] | undefined,
  summary: string,
  source: string,
): AcceptanceCriterionEvidence[] {
  const criteria = value?.length ? value : ["verification"];
  return criteria.map((criterion) => ({
    label: criterion,
    status: "passed",
    evidence: summary,
    source,
  }));
}

function configString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function doctorStrictFailure(diagnosis: { status: string; findings: Array<{ severity: string }> }): boolean {
  return diagnosis.status !== "ok" || diagnosis.findings.some((finding) => finding.severity === "blocker");
}

function result(value: unknown) {
  const structuredContent = isRecord(value) ? value : { value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
