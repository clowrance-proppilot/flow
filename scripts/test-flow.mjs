#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { run } from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const flowRoot = join(scriptDir, "..");
const mcpEntryShim = join(flowRoot, ".tmp", "test", "src", "flow.js");

const defaultTestFiles = [
  "test/flow.test.ts",
  "test/experimental/autoflow-runner.test.ts",
  "test/experimental/work-runtime-autoflow.test.ts",
  "test/dashboard-queue.test.ts",
  "test/dashboard-state.test.ts",
  "test/reconciliation.test.ts",
  "test/sql-state.test.ts",
  "test/sql-store.test.ts",
  "test/readiness.test.ts",
  "test/adapter-triage.test.ts",
  "test/linear-adapter.test.ts",
  "test/local-adapter.test.ts",
  "test/notion-adapter.test.ts",
  "test/host-mediated.test.ts",
  "test/execution-plane.test.ts",
  "test/hatchet-execution.test.ts",
];

writeMcpEntryShim();
await runTests(resolveTestFiles(process.argv.slice(2)));

function writeMcpEntryShim() {
  mkdirSync(dirname(mcpEntryShim), { recursive: true });
  const sourceEntry = join(flowRoot, "src", "flow.ts");
  const tsxRegister = import.meta.resolve("tsx/esm");
  writeFileSync(
    mcpEntryShim,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["--import", ${JSON.stringify(tsxRegister)}, ${JSON.stringify(sourceEntry)}, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`,
  );
}

function resolveTestFiles(args) {
  const requested = args.length ? args : defaultTestFiles;
  return requested.map((file) => {
    const resolved = isAbsolute(file) ? file : join(flowRoot, file);
    if (!existsSync(resolved)) throw new Error(`Missing test file: ${normalize(file)}`);
    return resolved;
  });
}

async function runTests(files) {
  const stream = run({ files });
  const counts = { pass: 0, fail: 0 };
  const failures = [];

  for await (const event of stream) {
    if (event.type === "test:pass") counts.pass += 1;
    if (event.type === "test:fail") {
      counts.fail += 1;
      failures.push(event.data?.name ?? "unknown test");
    }
  }

  if (counts.fail > 0) {
    throw new Error(`flow-runtime tests failed: ${failures.join(", ")}`);
  }
  console.log(`flow-runtime tests: ${counts.pass} passed`);
}
