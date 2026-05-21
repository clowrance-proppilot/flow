#!/usr/bin/env node
import { Command } from "commander";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const flowRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const program = new Command()
  .name("flow-autoflow")
  .description("Run Flow autoflow against one issue through the Flow CLI.")
  .argument("<issue-ref>", "issue key or ref, for example ISSUE-123")
  .option(
    "--flow-bin <path>",
    "Flow CLI path",
    process.env.FLOW_BIN ?? join(flowRoot, "bin", "flow"),
  )
  .option(
    "--cycles <count>",
    "maximum autoflow cycles",
    parsePositiveInteger,
    Number(process.env.FLOW_AUTOFLOW_CYCLES ?? 4),
  )
  .option(
    "--steps <count>",
    "maximum autoflow steps per cycle",
    parsePositiveInteger,
    Number(process.env.FLOW_AUTOFLOW_STEPS ?? 20),
  );

program.parse();

const [issueRef] = program.args;
const options = program.opts();

const flowBin = options.flowBin;
const maxCycles = options.cycles;
const maxSteps = options.steps;

const session = await call("createSession", {});
const queue = await call("inspectQueue", { limit: 50 });
const selectedIssue = Array.isArray(queue)
  ? queue.find((item) => item && typeof item === "object" && String(item.ref ?? "") === issueRef)
  : undefined;
await call("selectIssue", {
  sessionId: session.id,
  issue: selectedIssue ?? { ref: issueRef, title: issueRef, repoKeys: [], metadata: {} },
});

let finalResult = null;
for (let cycle = 0; cycle < maxCycles; cycle += 1) {
  finalResult = await call("autoFlowIssue", {
    sessionId: session.id,
    options: {
      autoPrepareWorkspace: true,
      autoApproveWorker: true,
      runWorker: true,
      maxSteps,
    },
  });
  const status = String(finalResult?.status ?? "");
  const message = String(finalResult?.message ?? "");
  if (status === "review_ready" || status === "done") break;
  if (message.toLowerCase().includes("blocked on provider escalation")) break;
}

const issue = finalResult?.issue ?? null;
const output = {
  sessionId: session.id,
  issueRef,
  status: finalResult?.status ?? "unknown",
  message: finalResult?.message ?? "",
  finalIssueState: issue?.state ?? undefined,
};
console.log(JSON.stringify(output, null, 2));

async function call(method, params) {
  const { stdout, stderr } = await execFileAsync(flowBin, ["call", method, JSON.stringify(params)], {
    cwd: process.env.FLOW_PROJECT_ROOT ?? process.cwd(),
    maxBuffer: 20 * 1024 * 1024,
  });
  if (stderr.trim()) process.stderr.write(stderr);
  return JSON.parse(stdout);
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got ${value}.`);
  }
  return parsed;
}
