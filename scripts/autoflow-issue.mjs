#!/usr/bin/env node
import { Command } from "commander";

const program = new Command()
  .name("flow-autoflow")
  .description("Run Flow autoflow against one Jira issue through the Work Runtime.")
  .argument("<issue-ref>", "Jira issue key, for example FSB-15737")
  .option(
    "--work-runtime-url <url>",
    "Work Runtime URL",
    process.env.FLOW_WORK_RUNTIME_URL ?? "http://127.0.0.1:8771",
  )
  .option(
    "--cycles <count>",
    "maximum autoflow cycles",
    parsePositiveInteger,
    Number(process.env.FLOW_AUTOFLOW_CYCLES ?? 4),
  )
  .option(
    "--steps <count>",
    "maximum Work Runtime autoflow steps per cycle",
    parsePositiveInteger,
    Number(process.env.FLOW_AUTOFLOW_STEPS ?? 20),
  );

program.parse();

const [issueRef] = program.args;
const options = program.opts();

const workRuntimeUrl = options.workRuntimeUrl.replace(/\/+$/, "");
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
  if (message.toLowerCase().includes("blocked on leaf escalation")) break;
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
  const response = await fetch(`${workRuntimeUrl}/v1/work-runtime`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error ?? `${method} failed`);
  }
  return payload.result;
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got ${value}.`);
  }
  return parsed;
}
