import {
  HATCHET_AUTOFLOW_TASK_NAME,
  HATCHET_AUTOFLOW_VERSION,
  HatchetAutoflowExecutionProvider,
  createHatchetAutoflowTask,
  createHatchetClient,
  type HatchetAutoflowPayload,
  type HatchetClientLike,
  type HatchetTaskDeclaration,
} from "../src/index.js";

type HatchetReadyWorker = {
  start(): Promise<void>;
  stop?(): Promise<void>;
  waitUntilReady?(timeoutMs?: number): Promise<void>;
};

const requiredEnv = ["HATCHET_CLIENT_TOKEN", "HATCHET_CLIENT_HOST_PORT"];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  throw new Error(`Hatchet smoke requires ${missingEnv.join(", ")}. Start Hatchet and export the SDK env first.`);
}

const smokeTimeout = setTimeout(() => {
  console.error("Hatchet smoke timed out after 90s.");
  process.exit(1);
}, 90_000);

const client = await createHatchetClient();
const seenInputs: HatchetAutoflowPayload[] = [];

const task = createHatchetAutoflowTask(client, {
  async runAutoflowIssue(input) {
    seenInputs.push(input);
    return {
      issueRef: input.issueRef,
      runId: input.runId,
      status: "succeeded",
      summary: `smoked ${input.issueRef}`,
      changedFiles: [],
      testsRun: ["npm run smoke:hatchet"],
      completedAt: new Date().toISOString(),
    };
  },
});

await main().catch((error) => {
  console.error(redactSecret(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(smokeTimeout);
});

async function main(): Promise<void> {
  console.error("hatchet smoke: starting worker");
  const worker = await startSmokeWorker(client, task);

  try {
    const provider = new HatchetAutoflowExecutionProvider({
      client,
      task,
      dashboardUrl: process.env.HATCHET_DASHBOARD_URL,
    });
    console.error("hatchet smoke: enqueueing run");
    const handle = await withTimeout(provider.enqueueAutoflowRun({
      projectId: "flow-smoke",
      issueRef: "GH-000",
      repoKeys: ["flow"],
      requestedBy: "daemon",
      runId: `flow-smoke-${Date.now()}`,
      durableSession: {
        provider: "pi",
        issueRef: "GH-000",
        flowSessionId: "flow-smoke-session",
        piSessionId: "pi-smoke-session",
        sessionFile: "smoke-session.jsonl",
        workspacePath: process.cwd(),
      },
    }), 30_000, "Timed out enqueueing Hatchet Autoflow smoke run.");

    console.error(`hatchet smoke: waiting for run ${handle.runId}`);
    await waitForWorkerExecution(handle.runId);
    const input = seenInputs[0];
    if (!input) throw new Error("Hatchet worker did not execute the Autoflow task.");
    if (input.taskName !== HATCHET_AUTOFLOW_TASK_NAME) throw new Error(`Unexpected task name ${input.taskName}.`);
    if (input.version !== HATCHET_AUTOFLOW_VERSION) throw new Error(`Unexpected payload version ${input.version}.`);
    if (input.durableSession?.piSessionId !== "pi-smoke-session") throw new Error("Durable Pi session handle was not delivered.");

    console.log(JSON.stringify({
      ok: true,
      smoke: "hatchet",
      runId: handle.runId,
      status: "executed",
      statusUrl: handle.statusUrl,
      executedTask: input.taskName,
    }));
  } finally {
    console.error("hatchet smoke: stopping worker");
    if (worker.stop) await withTimeout(worker.stop(), 10_000, "Timed out stopping Hatchet smoke worker.");
  }
}

async function startSmokeWorker(client: HatchetClientLike, task: HatchetTaskDeclaration): Promise<HatchetReadyWorker> {
  const worker = await client.worker(`flow-hatchet-smoke-${Date.now()}`, {
    workflows: [task],
    slots: 1,
  }) as HatchetReadyWorker;
  void worker.start().catch((error) => {
    console.error(`Hatchet smoke worker stopped with error: ${redactSecret(error instanceof Error ? error.message : String(error))}`);
  });
  if (worker.waitUntilReady) await withTimeout(worker.waitUntilReady(30_000), 35_000, "Timed out waiting for Hatchet smoke worker readiness.");
  return worker;
}

async function waitForWorkerExecution(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (seenInputs.length > 0) return;
    await sleep(1_000);
  }
  throw new Error(`Hatchet run ${runId} did not execute the Flow Autoflow task in time.`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactSecret(message: string): string {
  return message.replace(/eyJ[A-Za-z0-9._-]+/g, "[redacted-token]");
}
