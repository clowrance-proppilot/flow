#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync as run } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const flowRoot = join(scriptDir, "..");
const stateDir = mkdtempSync(join(tmpdir(), "flow-smoke-"));
const repoRoot = join(stateDir, "project");
const flowBin = join(flowRoot, "bin", "flow");

try {
  run("git", ["init", repoRoot], { stdio: "ignore" });
  const client = new Client({ name: "flow-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [flowBin],
    cwd: repoRoot,
    env: { ...mcpEnv(), FLOW_MCP_PROJECTS_PATH: join(stateDir, "mcp-projects.json") },
    stderr: "pipe",
  });

  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    if (!toolNames.includes("flow_projects")) throw new Error("Flow MCP did not expose flow_projects.");
    if (!toolNames.includes("flow_project_add")) throw new Error("Flow MCP did not expose flow_project_add.");
    if (toolNames.includes("flow_project_select")) throw new Error("Flow MCP exposed a mutable project selector.");
    if (!toolNames.includes("flow_issue_create")) throw new Error("Flow MCP did not expose flow_issue_create.");
    if (toolNames.includes("flow_runtime")) throw new Error("Flow MCP exposed a raw runtime bridge.");

    const projects = await callTool(client, "flow_projects");
    if (projects.defaultProject?.root !== repoRoot) throw new Error("Flow MCP did not register the smoke project root.");

    const bootstrap = await callTool(client, "flow_bootstrap", {});
    if (bootstrap.owner) throw new Error("bootstrap selected a provider adapter by default.");

    const configResult = await callTool(client, "flow_config_get");
    const config = configResult.config;
    if (configResult.path.includes(`${join(repoRoot, ".flow")}`)) throw new Error("Flow managed config should not be stored in the repo .flow directory.");
    if (config?.issueTracker?.type !== "local") throw new Error("smoke config did not use local issue tracker.");
    if (config?.collaboration?.type !== "none") throw new Error("smoke config did not use no-op collaboration.");
    if (config?.runtime?.worker) throw new Error("smoke config should not declare runtime.worker.");

    const created = await createReviewedIssue(client, {
      summary: "Smoke local Flow",
      description: "Core path needs only git.",
      issueType: "Task",
    });
    if (!String(created.ref ?? "").startsWith("PROJECT-")) {
      throw new Error(`unexpected local issue ref: ${created.ref}`);
    }
    const queue = await callTool(client, "flow_queue", { allProjects: true, limit: 10 });
    if (!queue.value?.some((issue) => issue.ref === created.ref && issue.projectRoot === repoRoot)) {
      throw new Error(`all-project queue did not include smoke issue: ${JSON.stringify(queue)}`);
    }
  } finally {
    await transport.close();
  }

  console.log("flow smoke: ok");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

async function createReviewedIssue(client, request) {
  const intake = await callTool(client, "flow_issue_intake", { ...request, dryRun: true, review: true });
  const reviewJob = intake.reviewJob;
  if (!reviewJob?.id || !reviewJob?.issueRef || !reviewJob?.repoKey || !reviewJob?.workType) {
    throw new Error(`issue intake did not return review job: ${JSON.stringify(intake)}`);
  }
  await callTool(client, "flow_record_work_job_result", {
    jobId: reviewJob.id,
    issueRef: reviewJob.issueRef,
    repoKey: reviewJob.repoKey,
    workType: reviewJob.workType,
    status: "succeeded",
    summary: "Executor approved issue intake.",
    evidence: ["Smoke executor review."],
    completedAt: new Date().toISOString(),
  });
  return callTool(client, "flow_issue_create", request);
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = result.content.find((item) => item.type === "text")?.text ?? "tool failed";
    throw new Error(text);
  }
  return result.structuredContent;
}

function mcpEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
  );
}
