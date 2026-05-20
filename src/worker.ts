import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type WorkerTaskRequest,
  type WorkerTaskResult,
  nowIso,
  workerTaskResultSchema,
} from "./contracts.js";
import { configuredPiValue, DEFAULT_PI_MODEL, DEFAULT_PI_PROVIDER } from "./pi-defaults.js";
import type { WorkerProgressSink, WorkerSpawner } from "./executors/worker-contracts.js";
export type { WorkerProgressEvent, WorkerProgressSink, WorkerSpawner } from "./executors/worker-contracts.js";

export interface PiWorkerSpawnerOptions {
  provider?: string;
  model?: string;
  timeoutMs?: number;
  extensionPath?: string;
  flowRoot?: string;
  sdkModulePath?: string;
}

export interface CodexWorkerSpawnerOptions {
  command?: string;
  timeoutMs?: number;
  flowRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DefaultWorkerSpawnerOptions extends PiWorkerSpawnerOptions {
  env?: NodeJS.ProcessEnv;
  codexAvailable?: (command: string, env: NodeJS.ProcessEnv) => boolean;
}

interface PiSdkLike {
  AuthStorage: { create(path?: string): any };
  ModelRegistry: { create(authStorage: any, modelPath?: string): any };
  SessionManager: { inMemory(cwd?: string): any };
  DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(): Promise<void> };
  createAgentSession(options: Record<string, unknown>): Promise<{ session: any }>;
}

export class PiWorkerSpawner implements WorkerSpawner {
  private readonly provider: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly extensionPath?: string;
  private readonly flowRoot?: string;
  private readonly sdkModulePath: string;

  constructor(options: PiWorkerSpawnerOptions = {}) {
    this.provider = configuredPiValue(options.provider) ??
      configuredPiValue(process.env.FLOW_WORKER_PROVIDER) ??
      configuredPiValue(process.env.FLOW_PROVIDER) ??
      DEFAULT_PI_PROVIDER;
    this.model = configuredPiValue(options.model) ??
      configuredPiValue(process.env.FLOW_WORKER_MODEL) ??
      configuredPiValue(process.env.FLOW_MODEL) ??
      DEFAULT_PI_MODEL;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.FLOW_PI_WORKER_TIMEOUT_MS ?? 2 * 60 * 1000);
    this.extensionPath = options.extensionPath ?? process.env.FLOW_PI_EXTENSION_PATH ?? defaultExtensionPath();
    this.flowRoot = options.flowRoot ?? process.env.FLOW_ROOT;
    this.sdkModulePath = options.sdkModulePath ?? process.env.FLOW_PI_SDK_MODULE_PATH ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
  }

  async run(request: WorkerTaskRequest, onProgress?: WorkerProgressSink): Promise<WorkerTaskResult> {
    try {
      const assistantText = await this.runWithSdk(request, onProgress);
      const structuredResult = parseStructuredWorkerResult(assistantText);
      if (structuredResult) {
        return workerTaskResultSchema.parse({
          ...structuredResult,
          taskId: request.id,
          issueRef: request.issueRef,
          repoKey: request.repoKey,
          executor: request.executor ?? structuredResult.executor,
          completedAt: structuredResult.completedAt ?? nowIso(),
        });
      }
      return workerTaskResultSchema.parse({
        taskId: request.id,
        issueRef: request.issueRef,
        repoKey: request.repoKey,
        executor: request.executor,
        status: "succeeded",
        summary: assistantText || "Pi Worker completed.",
        changedFiles: [],
        testsRun: [],
        blockers: [],
        completedAt: nowIso(),
      });
    } catch (error) {
      const message = errorMessage(error);
      if (process.env.FLOW_DEBUG_WORKER === "1") {
        // Debug toggle for local dogfood failures in Worker runtime wiring.
        console.error("[flow worker debug] run failure", {
          taskId: request.id,
          issueRef: request.issueRef,
          repoKey: request.repoKey,
          workspacePath: request.workspacePath,
          provider: this.provider,
          model: this.model,
          extensionPath: this.extensionPath,
          flowRoot: this.flowRoot,
          sdkModulePath: this.sdkModulePath,
          message,
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
      return workerTaskResultSchema.parse({
        taskId: request.id,
        issueRef: request.issueRef,
        repoKey: request.repoKey,
        executor: request.executor,
        status: "blocked",
        summary: compactErrorMessage(message),
        changedFiles: [],
        testsRun: [],
        blockers: [compactErrorMessage(message)],
        nextPickup: nextPickupForWorkerError(message),
        completedAt: nowIso(),
      });
    }
  }

  private async runWithSdk(request: WorkerTaskRequest, onProgress?: WorkerProgressSink): Promise<string | undefined> {
    const sdk = await this.withPhase("load_pi_sdk", () => loadPiSdk(this.sdkModulePath), request);

    const authStorage = sdk.AuthStorage.create();
    const modelRegistry = sdk.ModelRegistry.create(authStorage);
    const model = modelRegistry.find(this.provider, this.model);
    if (!model) throw new Error(`Pi model not found for provider/model: ${this.provider}/${this.model}`);
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

    const loader = await this.withPhase("resource_loader_init", async () =>
      new sdk.DefaultResourceLoader({
        cwd: request.workspacePath,
        agentDir,
        additionalExtensionPaths: this.extensionPath ? [this.extensionPath] : [],
        noContextFiles: true,
      }), request);
    await this.withPhase("resource_loader_reload", () => loader.reload(), request);

    const { session } = await this.withPhase("create_agent_session", () =>
      sdk.createAgentSession({
        cwd: request.workspacePath,
        model,
        authStorage,
        modelRegistry,
        resourceLoader: loader,
        sessionManager: sdk.SessionManager.inMemory(request.workspacePath),
      }), request);

    const deltas: string[] = [];
    let progressQueue = Promise.resolve();
    const emitProgress = (summary: string) => {
      progressQueue = progressQueue
        .then(async () => {
          await onProgress?.({
            taskId: request.id,
            issueRef: request.issueRef,
            repoKey: request.repoKey,
            summary,
            updatedAt: nowIso(),
          });
        })
        .catch(() => undefined);
    };

    const unsubscribe = session.subscribe((event: Record<string, unknown>) => {
      const summary = progressSummaryFromSessionEvent(event);
      if (summary) emitProgress(summary);
      if (event.type === "message_update") {
        const assistantMessageEvent = (event as { assistantMessageEvent?: Record<string, unknown> }).assistantMessageEvent;
        if (assistantMessageEvent?.type === "text_delta") {
          const delta = assistantMessageEvent.delta;
          if (typeof delta === "string") deltas.push(delta);
        }
      }
    });

    try {
      await this.withPhase("session_prompt", () =>
        withTimeout(session.prompt(request.prompt), this.timeoutMs, async () => {
          await session.abort();
        }), request);
    } finally {
      unsubscribe();
      session.dispose();
      await progressQueue;
    }

    const streamed = deltas.join("").trim();
    if (streamed) return streamed;
    return assistantTextFromMessages((session as { messages?: unknown }).messages);
  }

  private workerEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...(this.flowRoot ? { FLOW_ROOT: this.flowRoot } : {}),
    };
  }

  private async withPhase<T>(
    phase: string,
    operation: () => Promise<T> | T,
    request: WorkerTaskRequest,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const details = errorMessage(error);
      throw new Error(
        `[worker phase=${phase}] ${details} workspacePath=${request.workspacePath} extensionPath=${this.extensionPath} sdkModulePath=${this.sdkModulePath}`,
      );
    }
  }
}

export class CodexWorkerSpawner implements WorkerSpawner {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly flowRoot?: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: CodexWorkerSpawnerOptions = {}) {
    this.env = options.env ?? process.env;
    this.command = options.command ?? this.env.FLOW_CODEX_BIN ?? "codex";
    this.timeoutMs = options.timeoutMs ?? Number(this.env.FLOW_CODEX_WORKER_TIMEOUT_MS ?? 20 * 60 * 1000);
    this.flowRoot = options.flowRoot ?? this.env.FLOW_ROOT;
  }

  async run(request: WorkerTaskRequest, onProgress?: WorkerProgressSink): Promise<WorkerTaskResult> {
    try {
      await onProgress?.({
        taskId: request.id,
        issueRef: request.issueRef,
        repoKey: request.repoKey,
        summary: "Codex background executor started.",
        updatedAt: nowIso(),
      });
      const assistantText = await this.runCodex(request);
      const structuredResult = parseStructuredWorkerResult(assistantText);
      if (structuredResult) {
        return workerTaskResultSchema.parse({
          ...structuredResult,
          taskId: request.id,
          issueRef: request.issueRef,
          repoKey: request.repoKey,
          executor: request.executor ?? structuredResult.executor,
          completedAt: structuredResult.completedAt ?? nowIso(),
        });
      }
      return workerTaskResultSchema.parse({
        taskId: request.id,
        issueRef: request.issueRef,
        repoKey: request.repoKey,
        executor: request.executor,
        status: "succeeded",
        summary: assistantText || "Codex background executor completed.",
        changedFiles: [],
        testsRun: [],
        blockers: [],
        completedAt: nowIso(),
      });
    } catch (error) {
      const message = errorMessage(error);
      return workerTaskResultSchema.parse({
        taskId: request.id,
        issueRef: request.issueRef,
        repoKey: request.repoKey,
        executor: request.executor,
        status: "blocked",
        summary: compactErrorMessage(message),
        changedFiles: [],
        testsRun: [],
        blockers: [compactErrorMessage(message)],
        nextPickup: nextPickupForWorkerError(message),
        completedAt: nowIso(),
      });
    }
  }

  private async runCodex(request: WorkerTaskRequest): Promise<string> {
    const outputPath = join(tmpdir(), `flow-codex-${safeFilePart(request.id)}-${Date.now()}.txt`);
    const prompt = codexWorkerPrompt(request);
    const args = [
      "exec",
      "--cd",
      request.workspacePath ?? process.cwd(),
      "--output-last-message",
      outputPath,
      "--dangerously-bypass-approvals-and-sandbox",
      prompt,
    ];
    const env = {
      ...this.env,
      ...(this.flowRoot ? { FLOW_ROOT: this.flowRoot } : {}),
    };

    const result = await runProcess(this.command, args, { env, timeoutMs: this.timeoutMs });
    const fileText = readTextFile(outputPath);
    rmSync(outputPath, { force: true });
    if (result.exitCode !== 0) {
      throw new Error([
        `Codex background executor exited with code ${result.exitCode}.`,
        result.signal ? `signal=${result.signal}` : "",
        result.stderr,
        result.stdout,
        fileText,
      ].filter(Boolean).join("\n"));
    }
    return (fileText || result.stdout).trim();
  }
}

export function createDefaultWorkerSpawner(options: DefaultWorkerSpawnerOptions = {}): WorkerSpawner {
  const env = options.env ?? process.env;
  const executor = env.FLOW_WORKER_EXECUTOR?.trim().toLowerCase();
  if (executor === "codex") {
    return new CodexWorkerSpawner({ ...options, env });
  }
  if (executor === "pi") {
    return new PiWorkerSpawner(options);
  }
  const command = env.FLOW_CODEX_BIN ?? "codex";
  const hasPiProviderCredentials = Boolean(env.OPENROUTER_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY);
  const isCodexAvailable = options.codexAvailable ?? codexCommandAvailable;
  if (!hasPiProviderCredentials && isCodexAvailable(command, env)) {
    return new CodexWorkerSpawner({ ...options, env, command });
  }
  return new PiWorkerSpawner(options);
}

async function loadPiSdk(modulePath: string): Promise<PiSdkLike> {
  const resolved = modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath;
  const sdk = await import(resolved);
  return sdk as PiSdkLike;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Promise<void>): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      void onTimeout().catch(() => undefined);
      reject(new Error(`Pi Worker timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function progressSummaryFromSessionEvent(event: Record<string, unknown>): string | undefined {
  if (event.type === "tool_execution_start") {
    return `Tool started: ${String(event.toolName ?? "unknown")}`;
  }
  if (event.type === "tool_execution_end") {
    return `Tool finished: ${String(event.toolName ?? "unknown")}`;
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update && typeof update === "object") {
      const record = update as Record<string, unknown>;
      if (record.type === "toolcall_start") return "Worker is calling a tool.";
    }
  }
  return undefined;
}

function parseStructuredWorkerResult(text: string | undefined): Partial<WorkerTaskResult> | undefined {
  if (!text) return undefined;
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
  const raw = match?.[1] ?? text;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkerTaskResult>;
    if (typeof parsed.status !== "string" || typeof parsed.summary !== "string") return undefined;
    const summary = pickReadableText(parsed.summary) ??
      pickReadableText(raw) ??
      pickReadableText(text) ??
      "Worker returned malformed or truncated structured output.";
    const changedFiles = normalizeStringArray(parsed.changedFiles);
    const testsRun = normalizeStringArray(parsed.testsRun);
    const blockers = normalizeStringArray(parsed.blockers);
    const nextPickup = pickReadableText(
      typeof parsed.nextPickup === "string" ? parsed.nextPickup : undefined,
    ) ?? (
      parsed.status === "blocked" || parsed.status === "failed"
        ? "Observe the latest worker run for concrete blocker details, then retry with a narrower prompt or corrected repo/workspace context."
        : undefined
    );
    const handoffPrompt = pickReadableLongText(typeof parsed.handoffPrompt === "string" ? parsed.handoffPrompt : undefined);
    if ((parsed.status === "blocked" || parsed.status === "failed") && blockers.length === 0) {
      blockers.push(summary);
    }
    return {
      status: parsed.status,
      summary,
      changedFiles,
      testsRun,
      blockers,
      nextPickup,
      handoffPrompt,
      evidenceCandidate:
        parsed.evidenceCandidate && typeof parsed.evidenceCandidate === "object"
          ? parsed.evidenceCandidate
          : undefined,
      completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : undefined,
    };
  } catch {
    return undefined;
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return pickReadableText(entry);
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name : "";
        const status = typeof record.status === "string" ? record.status : "";
        const details = typeof record.details === "string" ? record.details : "";
        return pickReadableText([name, status, details].filter(Boolean).join(" ").trim());
      }
      return undefined;
    })
    .filter((entry): entry is string => Boolean(entry));
}

function pickReadableText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  if (!/[a-zA-Z0-9]/.test(compact)) return undefined;
  if (/^[\[\]{}(),:;'"`]+$/.test(compact)) return undefined;
  return compact.slice(0, 500);
}

function pickReadableLongText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.trim();
  if (!compact) return undefined;
  if (!/[a-zA-Z0-9]/.test(compact)) return undefined;
  if (/^[\s\[\]{}(),:;'"`]+$/.test(compact)) return undefined;
  return compact.slice(0, 8000);
}

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

function assistantTextFromMessages(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    const text = contentText(record.content);
    if (text) return text;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : "";
    const stack = typeof record.stack === "string" ? record.stack : "";
    const cause = stringifyUnknown(record.cause);
    const signal = typeof record.signal === "string" ? `signal=${record.signal}` : "";
    const code = typeof record.code === "string" || typeof record.code === "number" ? `code=${record.code}` : "";
    const killed = record.killed === true ? "killed=true" : "";
    const timedOut = record.timedOut === true ? "timedOut=true" : "";
    const details = stringifyUnknown(record.details);
    const errors = stringifyUnknown(record.errors);
    const fallback = stringifyUnknown(error);
    return [message, stack, cause, signal, code, killed, timedOut, details, errors, fallback]
      .filter((part) => typeof part === "string" && part.trim())
      .join(" ") || "Pi Worker failed.";
  }
  return String(error);
}

function compactErrorMessage(message: string): string {
  if (/SIGTERM|ETIMEDOUT|timed out/i.test(message)) {
    return "Pi Worker timed out or was interrupted before returning a structured result.";
  }
  if (/No API key found|OPENROUTER_API_KEY is missing/i.test(message)) {
    return "Pi Worker could not find provider credentials.";
  }
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Command failed:"));
  const meaningfulLine = lines.find((line) => /[a-zA-Z0-9]/.test(line) && !/^[\[\]{}(),:;'"`]+$/.test(line));
  if (meaningfulLine) return meaningfulLine.slice(0, 500);
  const flattened = message.replace(/\s+/g, " ").trim();
  const compact = flattened.slice(0, 500);
  if (compact && /[a-zA-Z0-9]/.test(compact) && !/^[\[\]{}(),:;'"`]+$/.test(compact)) return compact;
  return "Pi Worker failed without a readable error message. Enable FLOW_DEBUG_WORKER=1 and inspect the Flow stderr log for raw diagnostics.";
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (value instanceof Error) {
    const name = value.name?.trim() ?? "";
    const message = value.message?.trim() ?? "";
    const stack = value.stack?.trim() ?? "";
    return [name, message, stack].filter(Boolean).join(": ");
  }
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => stringifyUnknown(entry)).filter(Boolean).join(" ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : "";
    const stack = typeof record.stack === "string" ? record.stack : "";
    const code = typeof record.code === "string" || typeof record.code === "number" ? `code=${record.code}` : "";
    const cause = stringifyUnknown(record.cause);
    const json = safeJson(value);
    return [message, stack, code, cause, json].filter((part) => part && part !== "{}").join(" ");
  }
  return String(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function nextPickupForWorkerError(message: string): string {
  if (/SIGTERM|ETIMEDOUT|timed out/i.test(message)) {
    return "Inspect the Worker lifecycle record, then rerun with a longer timeout or split the task smaller.";
  }
  if (/No API key found|OPENROUTER_API_KEY is missing/i.test(message)) {
    return "Configure Pi provider credentials, then rerun the Worker request.";
  }
  if (/Codex background executor exited|command not found|ENOENT/i.test(message)) {
    return "Inspect the Codex executor error, then retry after fixing the local Codex CLI/runtime configuration.";
  }
  return "Observe the latest worker run for concrete blocker details, then retry with a narrower prompt or corrected repo/workspace context.";
}

function codexWorkerPrompt(request: WorkerTaskRequest): string {
  return [
    `You are a background executor for FARMserver Jira issue ${request.issueRef}.`,
    "",
    "Use the workspace you were launched in. Keep the change scoped to the Flow-provided task.",
    "Do not create commits, push branches, mark PRs ready, or write Jira/GitHub comments.",
    "",
    request.prompt,
    "",
    "Return your final response as only one JSON object with this shape:",
    JSON.stringify({
      status: "succeeded|blocked|failed",
      summary: "short human-readable result",
      changedFiles: ["path/from/workspace"],
      testsRun: ["command and result"],
      blockers: ["remaining blocker"],
      nextPickup: "next action if blocked",
      evidenceCandidate: "optional concise evidence to record",
    }, null, 2),
  ].join("\n");
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, String(chunk));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  return combined.length > 20_000 ? combined.slice(-20_000) : combined;
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "worker";
}

function codexCommandAvailable(command: string, env: NodeJS.ProcessEnv): boolean {
  if (command.includes("/")) return existsSync(command);
  const pathEntries = (env.PATH ?? "").split(":").filter(Boolean);
  return pathEntries.some((entry) => existsSync(join(entry, command))) ||
    existsSync("/opt/homebrew/bin/codex") ||
    existsSync("/usr/local/bin/codex");
}

function defaultExtensionPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "extensions", "flow.ts"),
    join(here, "..", "..", "flow", "extensions", "flow.ts"),
    join(process.cwd(), "tools", "flow", "extensions", "flow.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
