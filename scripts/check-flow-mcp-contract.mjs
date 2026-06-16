#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const flowRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const flowEntryPath = join(flowRoot, "src", "flow.ts");
const mcpServerPath = join(flowRoot, "src", "mcp-server.ts");
const jsonCliPath = join(flowRoot, "src", "json-cli.ts");
const packageJsonPath = join(flowRoot, "package.json");

const flowEntry = readFileSync(flowEntryPath, "utf8");
const mcpServer = readFileSync(mcpServerPath, "utf8");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const violations = [];

if (existsSync(jsonCliPath)) {
  violations.push("Flow must not ship src/json-cli.ts; MCP is the only external agent surface.");
}
checkPresent(flowEntry, /startFlowMcpServer/, "src/flow.ts must start the Flow MCP server.");
checkAbsent(flowEntry, /runJsonCli|JSON\.parse|process\.argv|process\.stdout\.write/, "src/flow.ts must not parse CLI requests or write JSON command responses.");
checkPresent(mcpServer, /@modelcontextprotocol\/sdk\/server\/mcp\.js/, "Flow MCP server must use the official MCP server SDK.");
checkPresent(mcpServer, /StdioServerTransport/, "Flow MCP server must expose stdio transport.");
checkPresent(mcpServer, /registerTool\("flow_projects"/, "Flow MCP server must expose project registry listing as a typed tool.");
checkPresent(mcpServer, /registerTool\("flow_project_add"/, "Flow MCP server must expose project registration as a typed tool.");
checkPresent(mcpServer, /allProjects/, "Flow MCP server must support reading across registered projects.");
checkAbsent(mcpServer, /registerTool\("flow_project_select"|registerTool\("flow_project_current"/, "Flow MCP must not expose a mutable active-project switch.");
checkPresent(mcpServer, /registerTool\("flow_config_get"/, "Flow MCP server must expose managed config reads as a typed tool.");
checkPresent(mcpServer, /registerTool\("flow_config_update"/, "Flow MCP server must expose managed config updates as a typed tool.");
checkPresent(mcpServer, /registerTool\("flow_issue_create"/, "Flow MCP server must expose issue creation as a typed tool.");
checkPresent(mcpServer, /registerTool\("flow_prepare_workspace"/, "Flow MCP server must expose workspace preparation as a typed tool.");
checkPresent(mcpServer, /registerTool\("flow_record_result"/, "Flow MCP server must expose result recording as a typed tool.");
checkAbsent(mcpServer, /registerTool\(["']flow_runtime["']|raw Work Runtime|raw runtime|method:\s*z\.string/, "Flow MCP must not expose a raw runtime-method bridge.");
if (!packageJson.dependencies?.["@modelcontextprotocol/sdk"]) {
  violations.push("package.json must declare @modelcontextprotocol/sdk.");
}

if (violations.length > 0) {
  console.error("Flow MCP contract check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("flow mcp contract: ok");

function checkPresent(source, pattern, message) {
  if (!pattern.test(source)) violations.push(message);
}

function checkAbsent(source, pattern, message) {
  if (pattern.test(source)) violations.push(message);
}
