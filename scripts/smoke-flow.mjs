#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync as run } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const flowRoot = join(scriptDir, "..");
const stateDir = mkdtempSync(join(tmpdir(), "flow-smoke-"));
const repoRoot = join(stateDir, "project");
const flowBin = join(flowRoot, "bin", "flow");

try {
  run("git", ["init", repoRoot], { stdio: "ignore" });

  const bootstrap = callFlow({ op: "bootstrap", storage: "repo-tracked" });
  if (bootstrap.result?.owner) {
    throw new Error("bootstrap selected a provider adapter by default.");
  }

  const config = readFileSync(join(repoRoot, ".flow", "config.yaml"), "utf8");
  if (!/issueTracker:\s*\n\s*type: local/m.test(config)) throw new Error("smoke config did not use local issue tracker.");
  if (!/collaboration:\s*\n\s*type: none/m.test(config)) throw new Error("smoke config did not use no-op collaboration.");
  if (/^\s*worker:/m.test(config)) throw new Error("smoke config should not declare runtime.worker.");

  const created = createReviewedIssue({
    op: "issue",
    mode: "create",
    summary: "Smoke local Flow",
    description: "Core path needs only git.",
    issueType: "Task",
  });
  if (!String(created.result?.ref ?? "").startsWith("PROJECT-")) {
    throw new Error(`unexpected local issue ref: ${created.result?.ref}`);
  }

  console.log("flow smoke: ok");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

function createReviewedIssue(request) {
  const intake = callFlow({ ...request, mode: "intake", dryRun: true });
  const reviewJob = intake.result?.reviewJob;
  if (!reviewJob?.id || !reviewJob?.issueRef || !reviewJob?.repoKey || !reviewJob?.workType) {
    throw new Error(`issue intake did not return review job: ${JSON.stringify(intake.result)}`);
  }
  callFlow({
    op: "runtime",
    method: "recordWorkJobResult",
    params: {
      result: {
        jobId: reviewJob.id,
        issueRef: reviewJob.issueRef,
        repoKey: reviewJob.repoKey,
        workType: reviewJob.workType,
        status: "succeeded",
        summary: "Executor approved issue intake.",
        evidence: ["Smoke executor review."],
        completedAt: new Date().toISOString(),
      },
    },
  });
  return callFlow(request);
}

function callFlow(body) {
  const stdout = run(process.execPath, [flowBin, JSON.stringify(body)], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  if (parsed.ok === false) throw new Error(`Flow CLI failed: ${JSON.stringify(parsed.error)}`);
  return parsed;
}
