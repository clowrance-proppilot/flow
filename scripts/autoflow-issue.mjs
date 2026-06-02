#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const flowRoot = dirname(dirname(scriptPath));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main(process.argv.slice(2));
}

export async function main(args) {
  const { issueRef } = parseArgs(args);

  const { repoRoot } = await import("../src/flow-runtime.js");
  const { validateFlowConfig } = await import("../src/config/config-loader.js");
  const { createConfiguredWorkRuntime } = await import("../src/runtime-factory.js");
  const { StandaloneAutoflowRunner, createDefaultAutoflowRunnerState } = await import("../src/experimental/autoflow-runner.js");
  const { PiSessionDriver } = await import("../src/pi-session-driver.js");
  const { ClaudeSessionDriver } = await import("../src/claude-session-driver.js");

  const configValidation = await validateFlowConfig({ projectRoot: repoRoot });
  const configuredRuntime = createConfiguredWorkRuntime({ projectRoot: repoRoot, flowConfig: configValidation.config });
  const flowConfig = configuredRuntime.flowConfig;
  const runtime = configuredRuntime.runtime;

  const projectId = configString(flowConfig?.project, "name") ?? "default";
  const agentSessionDriver = createAgentSessionDriver(projectId, flowConfig, runtime, repoRoot);

  const runner = new StandaloneAutoflowRunner({
    projectId,
    runtime,
    state: createDefaultAutoflowRunnerState(repoRoot),
    agentSessionDriver,
    codeReviewCreator: configuredRuntime.collaboration?.createCodeReview
      ? {
        async createPullRequest(input) {
          const review = await configuredRuntime.collaboration.createCodeReview?.({
            repo: input.repo,
            title: input.title,
            body: input.body,
            sourceBranch: input.headRefName,
            targetBranch: input.baseRefName,
          });
          if (!review) throw new Error("Code review creation is not configured.");
          return {
            repo: review.repo,
            number: Number(review.id),
            url: review.url,
            headRefName: review.sourceBranch,
            isDraft: review.isDraft,
            checksPassing: review.checksPassing,
            reviewDecision: review.reviewDecision,
          };
        },
      }
      : undefined,
  });

  const finalResult = await runner.tick({ issueRefs: [issueRef], wait: true });
  const issueStatus = finalResult?.issues?.[issueRef] ?? null;
  const output = {
    issueRef,
    status: issueStatus?.phase ?? "unknown",
    message: issueStatus?.summary ?? finalResult?.summary ?? "",
    sessionId: issueStatus?.sessionId,
    workspacePath: issueStatus?.workspacePath,
  };
  console.log(JSON.stringify(output, null, 2));
}

function createAgentSessionDriver(projectId, flowConfig, runtime, repoRoot) {
  const provider = configString(configRecord(flowConfig?.runtime, "agentSession"), "provider") ?? "pi";
  const options = {
    runtime,
    repoRoot,
    flowSessionId: `autoflow-${projectId.toLowerCase()}`,
  };
  if (provider === "pi") return new PiSessionDriver(options);
  if (provider === "claude") return new ClaudeSessionDriver(options);
  throw new Error(`Unsupported runtime.agentSession.provider: ${provider}.`);
}

export function flowInvocationForBin(flowBin, platform = process.platform, nodePath = process.execPath) {
  const lower = flowBin.toLowerCase();
  if (platform !== "win32") return { command: flowBin, argsPrefix: [] };
  if (lower.endsWith(".ps1")) {
    throw new Error("PowerShell flow shims cannot be launched by execFile. Use the repository bin/flow script or a .cmd/.exe flow shim.");
  }
  if (lower.endsWith(".cmd") || lower.endsWith(".bat") || lower.endsWith(".exe") || lower.endsWith(".com")) {
    return { command: flowBin, argsPrefix: [] };
  }
  return { command: nodePath, argsPrefix: [flowBin] };
}

function parseArgs(args) {
  const parsed = {
    issueRef: "",
    flowBin: join(flowRoot, "bin", "flow"),
    maxCycles: 4,
    maxSteps: 20,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--flow-bin") {
      parsed.flowBin = requireArgValue(args, index);
      index += 1;
    } else if (arg === "--cycles") {
      parsePositiveInteger(requireArgValue(args, index));
      index += 1;
    } else if (arg === "--steps") {
      parsePositiveInteger(requireArgValue(args, index));
      index += 1;
    } else if (!parsed.issueRef) {
      parsed.issueRef = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (!parsed.issueRef) throw new Error("Expected issue ref argument.");
  return parsed;
}

function requireArgValue(args, index) {
  const value = args[index + 1];
  if (!value) throw new Error(`Expected value after ${args[index]}.`);
  return value;
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got ${value}.`);
  }
  return parsed;
}

function configString(config, key) {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function configRecord(config, key) {
  const value = config?.[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
