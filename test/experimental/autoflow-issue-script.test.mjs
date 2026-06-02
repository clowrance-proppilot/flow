import assert from "node:assert/strict";
import test from "node:test";

import { flowInvocationForBin } from "../../scripts/autoflow-issue.mjs";

test("autoflow issue script launches extensionless Flow bin through node on Windows", () => {
  assert.deepEqual(
    flowInvocationForBin("C:\\repo\\bin\\flow", "win32", "C:\\node\\node.exe"),
    { command: "C:\\node\\node.exe", argsPrefix: ["C:\\repo\\bin\\flow"] },
  );
});

test("autoflow issue script launches Windows executable shims directly", () => {
  assert.deepEqual(
    flowInvocationForBin("C:\\Users\\camde\\AppData\\Roaming\\npm\\flow.cmd", "win32", "C:\\node\\node.exe"),
    { command: "C:\\Users\\camde\\AppData\\Roaming\\npm\\flow.cmd", argsPrefix: [] },
  );
});

test("autoflow issue script rejects PowerShell shims with an actionable error", () => {
  assert.throws(
    () => flowInvocationForBin("C:\\Users\\camde\\AppData\\Roaming\\npm\\flow.ps1", "win32", "C:\\node\\node.exe"),
    /PowerShell flow shims cannot be launched by execFile/,
  );
});

test("autoflow issue script preserves Unix shebang execution", () => {
  assert.deepEqual(
    flowInvocationForBin("/repo/bin/flow", "linux", "/usr/bin/node"),
    { command: "/repo/bin/flow", argsPrefix: [] },
  );
});
