import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";

import { configuredPiValue, DEFAULT_PI_MODEL, DEFAULT_PI_PROVIDER } from "./pi-defaults.js";

export interface RunFlowPromptOptions {
  prompt: string;
  noSession?: boolean;
  sessionFile?: string;
  onTextDelta?: (delta: string) => void;
  additionalSystemPrompts?: string[];
}

export interface RunFlowPromptResult {
  text: string;
  session: "in-memory" | "persistent";
}

const runtimeDir = resolve(import.meta.dirname);

function resolveFlowRoot(): string {
  const explicit = process.env.FLOW_PACKAGE_ROOT;
  if (explicit && existsSync(join(explicit, "package.json")) && existsSync(join(explicit, "src"))) {
    return resolve(explicit);
  }
  let cursor = runtimeDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(cursor);
    if (existsSync(join(candidate, "package.json")) && existsSync(join(candidate, "src")) && existsSync(join(candidate, "bin"))) {
      return candidate;
    }
    cursor = resolve(cursor, "..");
  }
  return resolve(runtimeDir, "../..");
}

export const flowRoot = resolveFlowRoot();
export const repoRoot = resolve(process.env.FLOW_PROJECT_ROOT ?? process.cwd());

export function loadFlowEnv(): void {
  loadEnv(join(process.env.HOME ?? "", ".config", "flow", "env"));
  loadEnv(join(flowRoot, ".env"));
  loadEnv(join(flowRoot, ".env.local"));
  if (!process.env.FLOW_ROOT) process.env.FLOW_ROOT = repoRoot;
}

export async function runFlowPrompt(options: RunFlowPromptOptions): Promise<RunFlowPromptResult> {
  loadFlowEnv();

  const sdk = await loadPiSdk(sdkModulePath());
  const extensionPath = defaultExtensionPath();
  if (!extensionPath) throw new Error("Flow could not find the Flow Pi extension.");

  const authStorage = sdk.AuthStorage.create();
  const modelRegistry = sdk.ModelRegistry.create(authStorage);
  const model = resolveConfiguredModel(modelRegistry);
  const noSession = Boolean(options.noSession);
  if (!noSession && options.sessionFile) {
    mkdirSync(dirname(options.sessionFile), { recursive: true });
  }
  const sessionManager = noSession
    ? sdk.SessionManager.inMemory(repoRoot)
    : options.sessionFile
      ? sdk.SessionManager.open(options.sessionFile, dirname(options.sessionFile), repoRoot)
      : sdk.SessionManager.create(repoRoot);
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const additionalSystemPrompts = options.additionalSystemPrompts?.filter(Boolean) ?? [];
  const appendSystemPrompt = [readFlowPrompt(), ...additionalSystemPrompts].filter(Boolean);
  const loader = new sdk.DefaultResourceLoader({
    cwd: repoRoot,
    agentDir,
    additionalExtensionPaths: [extensionPath],
    appendSystemPrompt,
    noContextFiles: true,
  });
  await loader.reload();

  const { session } = await sdk.createAgentSession({
    cwd: repoRoot,
    ...(model ? { model } : {}),
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    sessionManager,
    tools: flowToolNames,
  });

  let text = "";
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      text += delta;
      options.onTextDelta?.(delta);
    }
  });

  try {
    await session.prompt(options.prompt);
    return { text, session: noSession ? "in-memory" : "persistent" };
  } finally {
    unsubscribe();
    session.dispose();
  }
}

const flowToolNames = [
  "flow_inspect_queue",
  "flow_inspect_backlog",
  "flow_create_session",
  "flow_select_issue",
  "flow_bootstrap_jira_issue",
  "flow_create_jira_issue",
  "flow_move_issues_to_active_sprint",
  "flow_route_issue",
  "flow_prepare_workspace",
  "flow_advance_issue",
  "flow_handoff_summary",
  "flow_record_evidence",
  "flow_record_acceptance_writeback",
  "flow_record_review_confirmation",
  "flow_record_documentation",
  "flow_record_provider_escalation",
  "flow_record_pull_request",
  "flow_observe_executors",
  "flow_list_work_jobs",
  "flow_submit_work",
  "flow_record_executor_progress",
  "flow_adopt_local_thread",
  "flow_adopt_pending_local_thread",
  "flow_record_executor_result",
  "flow_run_background_executor",
  "flow_autoflow_issue",
  "flow_reset_autoflow_state",
];

function loadEnv(path: string): void {
  if (!path || !existsSync(path)) return;
  loadDotenv({ path, override: false });
}

function sdkModulePath(): string {
  return process.env.FLOW_PI_SDK_MODULE_PATH ??
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
}

async function loadPiSdk(modulePath: string): Promise<any> {
  const resolved = modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath;
  return await import(resolved);
}

function defaultExtensionPath(): string | undefined {
  const candidates = [
    join(flowRoot, "extensions", "flow.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function readFlowPrompt(): string {
  const candidates = [
    join(flowRoot, "prompts", "flow.md"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("Flow prompt not found.");
  return readFileSync(path, "utf8");
}

function resolveConfiguredModel(modelRegistry: any): unknown {
  const provider = configuredPiValue(process.env.FLOW_FLOW_PROVIDER) ??
    configuredPiValue(process.env.FLOW_PROVIDER) ??
    DEFAULT_PI_PROVIDER;
  const modelId = configuredPiValue(process.env.FLOW_FLOW_MODEL) ??
    configuredPiValue(process.env.FLOW_MODEL) ??
    DEFAULT_PI_MODEL;
  const model = modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Flow could not resolve model ${provider}/${modelId}.`);
  return model;
}
