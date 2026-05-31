#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { run } from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const flowRoot = join(scriptDir, "..");
const cliShim = join(flowRoot, ".tmp", "test", "src", "flow.js");

const defaultTestFiles = [
  "test/flow.test.ts",
  "test/autoflow-runner.test.ts",
  "test/autoflow-issue-script.test.mjs",
  "test/dashboard-state.test.ts",
  "test/sql-state.test.ts",
  "test/sql-store.test.ts",
  "test/readiness.test.ts",
  "test/work-runtime-autoflow.test.ts",
  "test/adapter-triage.test.ts",
];

writeCliShim();
await runTests(resolveTestFiles(process.argv.slice(2)));

function writeCliShim() {
  mkdirSync(dirname(cliShim), { recursive: true });
  const sourceCli = join(flowRoot, "src", "flow.ts");
  const tsxRegister = import.meta.resolve("tsx/esm");
  writeFileSync(
    cliShim,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["--import", ${JSON.stringify(tsxRegister)}, ${JSON.stringify(sourceCli)}, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
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
