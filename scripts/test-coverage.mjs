#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const flowRoot = join(scriptDir, "..");
const coverageDir = join(flowRoot, "coverage", "v8");
const cliShim = join(flowRoot, ".tmp", "test", "src", "flow.js");
const tsxRegister = pathToFileURL(join(flowRoot, "node_modules", "tsx", "dist", "esm", "index.mjs")).href;
const testFiles = [
  "test/flow.test.ts",
  "test/experimental/autoflow-runner.test.ts",
  "test/dashboard-state.test.ts",
  "test/sql-state.test.ts",
  "test/sql-store.test.ts",
];

rmSync(join(flowRoot, "coverage"), { recursive: true, force: true });
writeCliShim();

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

function writeCliShim() {
  mkdirSync(dirname(cliShim), { recursive: true });
  const sourceCli = join(flowRoot, "src", "flow.ts");
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
