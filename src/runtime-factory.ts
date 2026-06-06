import { AcliJiraAdapter } from "./adapters/jira.js";
import { GhGitHubAdapter, GhGitHubIssueTrackerAdapter } from "./adapters/github.js";
import { LocalIssueTrackerAdapter, NoopCodeCollaborationAdapter } from "./adapters/local.js";
import type { CodeCollaborationProvider, IssueTrackerProvider } from "./adapters/provider-contracts.js";
import type { FlowConfig } from "./config/config-schema.js";
import { configToProjectTopology, configToWorkTypeRegistry } from "./config/config-loader.js";
import { assessIssue } from "./readiness.js";
import { createFlowStore, type FlowStoreBackend } from "./store.js";
import { FlowWorkRuntime } from "./work-runtime.js";
import type { WorkflowLedger } from "./ledger.js";
import { flowRuntimePath, flowUserWorkflowLedgerDatabasePath, resolveFlowPath } from "./flow-layout.js";
import { createKyselyFlowState, createPostgresDialect, createPostgresSqlStateConfig, createSqliteSqlStateConfig } from "./sql-state.js";

export interface ConfiguredWorkRuntimeOptions {
  projectRoot: string;
  flowConfig?: FlowConfig;
}

export interface ConfiguredWorkRuntime {
  runtime: FlowWorkRuntime;
  flowConfig?: FlowConfig;
  workflowLedger: WorkflowLedger;
  issueTracker: IssueTrackerProvider;
  collaboration: CodeCollaborationProvider;
  runtimeStorePath: string;
  workflowLedgerPath: string;
}

export function createConfiguredWorkRuntime(options: ConfiguredWorkRuntimeOptions): ConfiguredWorkRuntime {
  const { projectRoot, flowConfig } = options;
  const { workflowLedger, workflowLedgerPath } = createConfiguredWorkflowLedger(projectRoot, flowConfig);
  const issueTracker = createIssueTracker(projectRoot, flowConfig, workflowLedger);
  const collaboration = createCollaboration(projectRoot, flowConfig);
  const runtimeStorePath = resolveRuntimeStorePath(projectRoot, flowConfig);
  const runtime = new FlowWorkRuntime({
    store: createFlowStore({ root: runtimeStorePath, backend: resolveRuntimeStoreBackend(flowConfig) }),
    ledger: workflowLedger,
    collaboration,
    issueTracker,
    defaultJiraProjectKey: configString(flowConfig?.issueTracker, "projectKey"),
    staleWorkerRunTimeoutMs: flowConfig?.runtime?.staleWorkerRunTimeoutMs,
    debugEnabled: flowConfig?.runtime?.debug,
    ...(flowConfig
      ? {
        topology: configToProjectTopology(flowConfig),
        workTypes: configToWorkTypeRegistry(flowConfig),
      }
      : {}),
    projectRoot,
    readiness: { assess: assessIssue },
  });

  return {
    runtime,
    flowConfig,
    workflowLedger,
    issueTracker,
    collaboration,
    runtimeStorePath,
    workflowLedgerPath,
  };
}

function createConfiguredWorkflowLedger(
  projectRoot: string,
  flowConfig: FlowConfig | undefined,
): { workflowLedger: WorkflowLedger; workflowLedgerPath: string } {
  const ledger = flowConfig?.ledger;
  const type = configString(ledger, "type") ?? "sql";
  if (type === "jsonl") {
    throw new Error("JSONL workflow ledger is no longer supported. Remove ledger.type from your Flow config or set it to 'sql' (default, uses SQLite).");
  }
  if (type === "flow") {
    const path = resolveSqlWorkflowLedgerPath(projectRoot, flowConfig);
    return {
      workflowLedgerPath: path,
      workflowLedger: createKyselyFlowState({
        root: projectRoot,
        dialectConfig: createSqliteSqlStateConfig({ path }),
      }),
    };
  }
  if (type === "sql") {
    const dialect = configString(ledger, "dialect") ?? "sqlite";
    if (dialect === "sqlite") {
      const path = resolveSqlWorkflowLedgerPath(projectRoot, flowConfig);
      return {
        workflowLedgerPath: path,
        workflowLedger: createKyselyFlowState({
          root: projectRoot,
          dialectConfig: createSqliteSqlStateConfig({ path }),
        }),
      };
    }
    if (dialect === "postgres") {
      const connectionString = resolvePostgresConnectionString(ledger);
      return {
        workflowLedgerPath: "<postgres>",
        workflowLedger: createKyselyFlowState({
          root: projectRoot,
          dialectConfig: createPostgresSqlStateConfig({
            connectionString,
            dialect: createPostgresDialect(connectionString),
          }),
        }),
      };
    }
    throw new Error(`Unsupported SQL workflow ledger dialect: ${dialect}.`);
  }
  throw new Error(`Unsupported workflow ledger adapter: ${type}. Supported adapters: sql.`);
}

function resolveRuntimeStorePath(projectRoot: string, flowConfig: FlowConfig | undefined): string {
  const configured = configString(flowConfig?.runtime, "storeDir") ?? configString(flowConfig?.runtime, "stateDir");
  return configured ? resolveFlowPath(projectRoot, configured) : flowRuntimePath(projectRoot);
}

function resolveSqlWorkflowLedgerPath(projectRoot: string, flowConfig: FlowConfig | undefined): string {
  const configured = configString(flowConfig?.ledger, "path");
  return configured ? resolveFlowPath(projectRoot, configured) : flowUserWorkflowLedgerDatabasePath(projectRoot);
}

function resolveRuntimeStoreBackend(flowConfig: FlowConfig | undefined): FlowStoreBackend {
  const store = configRecord(flowConfig?.runtime, "store");
  return configString(store, "type") === "file" ? "file" : "sqlite";
}

function createIssueTracker(projectRoot: string, flowConfig: FlowConfig | undefined, workflowLedger: WorkflowLedger): IssueTrackerProvider {
  const issueTracker = flowConfig?.issueTracker;
  const type = configString(issueTracker, "type") ?? "local";
  if (type === "local") {
    return new LocalIssueTrackerAdapter({
      ledger: workflowLedger,
      projectName: flowConfig?.project.name,
      prefix: configString(issueTracker, "prefix"),
    });
  }
  if (type === "github" || type === "github_issues") {
    return new GhGitHubIssueTrackerAdapter({
      cwd: projectRoot,
      owner: configString(issueTracker, "owner") ?? configString(flowConfig?.collaboration, "owner"),
      repo: configString(issueTracker, "repo") ?? configString(flowConfig?.collaboration, "repo") ?? "flow",
      assignee: configString(issueTracker, "assignee"),
      activeLabels: configStringArray(issueTracker, "activeLabels"),
      backlogLabels: configStringArray(issueTracker, "backlogLabels"),
    });
  }
  return new AcliJiraAdapter({
    cwd: projectRoot,
    siteUrl: configString(issueTracker, "siteUrl"),
    projectKey: configString(issueTracker, "projectKey"),
    activeQueueJql: configString(issueTracker, "activeQueueJql"),
    backlogQueueJql: configString(issueTracker, "backlogQueueJql"),
    email: configString(issueTracker, "email"),
    apiToken: configString(issueTracker, "apiToken"),
  });
}

function createCollaboration(projectRoot: string, flowConfig: FlowConfig | undefined): CodeCollaborationProvider {
  const collaboration = flowConfig?.collaboration;
  const type = configString(collaboration, "type") ?? "none";
  if (type === "none" || type === "local") {
    return new NoopCodeCollaborationAdapter();
  }
  return new GhGitHubAdapter({ cwd: projectRoot, owner: configString(collaboration, "owner") });
}

function configString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function configRecord(config: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = config?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function resolvePostgresConnectionString(config: Record<string, unknown> | undefined): string {
  const inline = configString(config, "connectionString");
  if (inline) return inline;
  const urlSecret = configString(config, "urlSecret");
  const fromSecret = urlSecret ? process.env[urlSecret] : undefined;
  if (fromSecret?.trim()) return fromSecret.trim();
  throw new Error("Postgres SQL workflow ledger requires ledger.connectionString or ledger.urlSecret pointing to an environment variable.");
}

function configStringArray(config: Record<string, unknown> | undefined, key: string): string[] {
  const value = config?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}
