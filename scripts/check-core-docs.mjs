#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const flowRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const docs = new Map([
  ["README.md", read("README.md")],
  ["docs/getting-started.md", read("docs/getting-started.md")],
  ["docs/cli-reference.md", read("docs/cli-reference.md")],
  ["docs/agent-handoff.md", read("docs/agent-handoff.md")],
]);

const violations = [];

requireText("README.md", /JSON contract/, "README must lead with the JSON CLI contract.");
requireText("README.md", /does not run agents/i, "README must say Flow core does not run agents.");
requireText("docs/getting-started.md", /All `flow` commands accept exactly one JSON request/, "Getting Started must document JSON-only CLI input.");
requireText("docs/getting-started.md", /Record completion evidence:/, "Getting Started must lead agents through recordResult/evidence/docs.");
requireText("docs/cli-reference.md", /Core CLI agent work should use the\s+issue and workflow commands above/i, "CLI reference must keep issue/workflow commands as the core path.");
requireText("docs/agent-handoff.md", /This path does not require Autoflow/i, "Agent handoff docs must not require Autoflow.");
requireText("docs/agent-handoff.md", /"mode":"adoptHandoff"/, "Agent handoff docs must show adoptHandoff.");
requireText("docs/agent-handoff.md", /"executor":"live_agent_thread"/, "Agent handoff docs must use live_agent_thread as the default handoff example.");

for (const [path, source] of docs) {
  if (/autoflow/i.test(source)) {
    requireInSource(path, source, /experimental/i, `${path} mentions Autoflow without an experimental label.`);
    requireInSource(path, source, /app-layer/i, `${path} mentions Autoflow without an app-layer boundary.`);
  }
}

if (violations.length > 0) {
  console.error("core docs boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("core docs boundary: ok");

function read(path) {
  return readFileSync(join(flowRoot, path), "utf8");
}

function requireText(path, pattern, message) {
  requireInSource(path, docs.get(path) ?? "", pattern, message);
}

function requireInSource(_path, source, pattern, message) {
  if (!pattern.test(source)) violations.push(message);
}
