#!/usr/bin/env node
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const flowRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const { issueRef, flowBin, maxCycles, maxSteps } = parseArgs(process.argv.slice(2));

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
  const { stdout, stderr } = await execFileAsync(flowBin, [JSON.stringify({ op: "runtime", method, params })], {
    cwd: process.cwd(),
    maxBuffer: 20 * 1024 * 1024,
  });
  if (stderr.trim()) process.stderr.write(stderr);
  const parsed = JSON.parse(stdout);
  if (parsed.ok === false) throw new Error(`Flow CLI failed: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
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
      parsed.maxCycles = parsePositiveInteger(requireArgValue(args, index));
      index += 1;
    } else if (arg === "--steps") {
      parsed.maxSteps = parsePositiveInteger(requireArgValue(args, index));
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
