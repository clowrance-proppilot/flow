#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const flowRoot = join(scriptDir, "..");
const coverageDir = join(flowRoot, "coverage", "v8");
const mcpEntryShim = join(flowRoot, ".tmp", "test", "src", "flow.js");
const tsxRegister = pathToFileURL(join(flowRoot, "node_modules", "tsx", "dist", "esm", "index.mjs")).href;
const testFiles = [
  "test/flow.test.ts",
  "test/experimental/autoflow-runner.test.ts",
  "test/dashboard-state.test.ts",
  "test/sql-state.test.ts",
  "test/sql-store.test.ts",
];

rmSync(join(flowRoot, "coverage"), { recursive: true, force: true });
writeMcpEntryShim();

const child = spawn(
  process.execPath,
  [
    "--import",
    tsxRegister,
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-include=src/**/*.ts",
    "--test-coverage-exclude=src/dashboard-ui.tsx",
    "--test-coverage-exclude=src/desktop-ui.tsx",
    ...testFiles,
  ],
  {
    cwd: flowRoot,
    env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
    stdio: "inherit",
  },
);

const exitCode = await new Promise((resolve) => {
  child.on("close", resolve);
});

process.exit(exitCode ?? 1);

function writeMcpEntryShim() {
  mkdirSync(dirname(mcpEntryShim), { recursive: true });
  const sourceEntry = join(flowRoot, "src", "flow.ts");
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
