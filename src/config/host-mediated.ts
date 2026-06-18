// Host-mediated issue tracker.
//
// Flow holds a *declarative* tool map and resolves the concrete MCP tool call
// the agent should make for a tracker operation. Flow does NOT perform provider
// I/O — the agent invokes the tool through its own MCP connection and reports
// the result back via flow_record_* tools. This keeps Flow in the control/state
// plane and out of the provider-plumbing business (no auth, pagination, retries
// here). The only provider-specific knowledge Flow carries is templating + an
// optional normalized-status -> provider-state-id map.

export const HOST_MEDIATED_TRACKER_TYPE = "host-mediated";

export const hostMediatedOperations = [
  "view",
  "fetchQueue",
  "fetchBacklog",
  "search",
  "transition",
  "comment",
  "create",
  "tag",
] as const;
export type HostMediatedOperation = (typeof hostMediatedOperations)[number];

// Variables an arg template may reference with $name.
export const hostMediatedVariables = [
  "ref",
  "status",
  "statusId",
  "body",
  "title",
  "description",
  "query",
  "labels",
  "assignee",
  "teamId",
  "binding",
  "limit",
] as const;

export interface ToolCallTemplate {
  tool: string;
  args?: Record<string, string>;
}

export interface HostMediatedTrackerConfig {
  type: typeof HOST_MEDIATED_TRACKER_TYPE;
  /** Logical provider/MCP this tracker delegates to, e.g. "linear". */
  binding: string;
  map: Partial<Record<HostMediatedOperation, ToolCallTemplate>>;
  /** Normalized status -> provider state id (e.g. "In Progress" -> a Linear state UUID). */
  statusMap?: Record<string, string>;
  teamId?: string;
}

export interface HostMediatedContext {
  ref?: string;
  status?: string;
  body?: string;
  title?: string;
  description?: string;
  query?: string;
  labels?: string[];
  assignee?: string;
  limit?: number;
}

export interface ResolvedDirective {
  binding: string;
  operation: HostMediatedOperation;
  tool: string;
  args: Record<string, unknown>;
}

export interface ConfigIssue {
  path: (string | number)[];
  message: string;
}

const VARIABLE_TOKEN = /\$([a-zA-Z][a-zA-Z0-9_]*)/g;
const EXACT_VARIABLE = /^\$([a-zA-Z][a-zA-Z0-9_]*)$/;

/**
 * Render the concrete tool call for an operation. Exact `$var` templates
 * preserve the variable's type (e.g. a number stays a number); templates with
 * surrounding text are string-interpolated. Throws if the operation is not
 * mapped or a referenced variable has no value.
 */
export function resolveTrackerDirective(
  tracker: HostMediatedTrackerConfig,
  operation: string,
  context: HostMediatedContext = {},
): ResolvedDirective {
  const entry = tracker.map?.[operation as HostMediatedOperation];
  if (!entry) {
    const mapped = Object.keys(tracker.map ?? {}).join(", ") || "(none)";
    throw new Error(
      `Host-mediated tracker has no mapping for operation "${operation}". Mapped operations: ${mapped}.`,
    );
  }
  const scope = buildScope(tracker, context);
  const args: Record<string, unknown> = {};
  for (const [argName, template] of Object.entries(entry.args ?? {})) {
    args[argName] = substitute(template, scope, operation, argName);
  }
  return { binding: tracker.binding, operation: operation as HostMediatedOperation, tool: entry.tool, args };
}

/**
 * Resolve a directive from a full Flow config, asserting the issue tracker is
 * host-mediated. Used by the flow_delegate MCP tool.
 */
export function resolveHostMediatedDirective(
  flowConfig: { issueTracker?: unknown } | undefined,
  operation: string,
  context: HostMediatedContext = {},
): ResolvedDirective {
  const tracker = isRecord(flowConfig?.issueTracker) ? flowConfig?.issueTracker : undefined;
  const typeRaw = tracker?.type;
  const type = typeof typeRaw === "string" ? typeRaw.trim().toLowerCase() : undefined;
  if (type !== HOST_MEDIATED_TRACKER_TYPE) {
    throw new Error(
      `flow_delegate requires issueTracker.type "host-mediated"; current type is "${type ?? "(unset)"}".`,
    );
  }
  return resolveTrackerDirective(tracker as unknown as HostMediatedTrackerConfig, operation, context);
}

/** Static validation of a host-mediated tracker config (used by flow_config_validate). */
export function validateHostMediatedTracker(raw: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const tracker = isRecord(raw) ? raw : undefined;

  const binding = tracker?.binding;
  if (typeof binding !== "string" || !binding.trim()) {
    issues.push({
      path: ["binding"],
      message:
        "issueTracker.binding is required when issueTracker.type is host-mediated (the MCP/provider this tracker delegates to).",
    });
  }

  const map = tracker?.map;
  if (!isRecord(map) || Object.keys(map).length === 0) {
    issues.push({
      path: ["map"],
      message:
        "issueTracker.map must be a non-empty object of operation -> { tool, args } when issueTracker.type is host-mediated.",
    });
    return issues;
  }

  const allowedVars = new Set<string>(hostMediatedVariables);
  for (const [operation, entry] of Object.entries(map)) {
    if (!hostMediatedOperations.includes(operation as HostMediatedOperation)) {
      issues.push({
        path: ["map", operation],
        message: `Unknown host-mediated operation "${operation}". Allowed: ${hostMediatedOperations.join(", ")}.`,
      });
      continue;
    }
    if (!isRecord(entry) || typeof entry.tool !== "string" || !entry.tool.trim()) {
      issues.push({ path: ["map", operation, "tool"], message: `issueTracker.map.${operation}.tool must be a non-empty MCP tool name.` });
      continue;
    }
    const args = entry.args;
    if (args === undefined) continue;
    if (!isRecord(args)) {
      issues.push({ path: ["map", operation, "args"], message: `issueTracker.map.${operation}.args must be an object of string templates.` });
      continue;
    }
    for (const [argName, value] of Object.entries(args)) {
      if (typeof value !== "string") {
        issues.push({
          path: ["map", operation, "args", argName],
          message: `issueTracker.map.${operation}.args.${argName} must be a string template (use $variable for substitution).`,
        });
        continue;
      }
      for (const variable of referencedVariables(value)) {
        if (!allowedVars.has(variable)) {
          issues.push({
            path: ["map", operation, "args", argName],
            message: `Unknown variable "$${variable}" in issueTracker.map.${operation}.args.${argName}. Allowed: ${hostMediatedVariables.map((v) => "$" + v).join(", ")}.`,
          });
        }
      }
    }
  }

  const statusMap = tracker?.statusMap;
  if (statusMap !== undefined) {
    if (!isRecord(statusMap)) {
      issues.push({ path: ["statusMap"], message: "issueTracker.statusMap must be an object mapping normalized statuses to provider state ids." });
    } else {
      for (const [statusName, value] of Object.entries(statusMap)) {
        if (typeof value !== "string" || !value.trim()) {
          issues.push({ path: ["statusMap", statusName], message: `issueTracker.statusMap.${statusName} must be a non-empty provider state id.` });
        }
      }
    }
  }

  return issues;
}

function buildScope(tracker: HostMediatedTrackerConfig, context: HostMediatedContext): Record<string, unknown> {
  const status = context.status;
  return {
    ref: context.ref,
    status,
    statusId: status !== undefined ? tracker.statusMap?.[status] : undefined,
    body: context.body,
    title: context.title,
    description: context.description,
    query: context.query,
    labels: context.labels,
    assignee: context.assignee,
    limit: context.limit,
    teamId: tracker.teamId,
    binding: tracker.binding,
  };
}

function substitute(template: string, scope: Record<string, unknown>, operation: string, argName: string): unknown {
  const exact = EXACT_VARIABLE.exec(template);
  if (exact) {
    const name = exact[1];
    const value = scope[name];
    if (value === undefined || value === null) {
      throw new Error(missingVariableMessage(name, operation, argName));
    }
    return value;
  }
  return template.replace(VARIABLE_TOKEN, (_match, name: string) => {
    const value = scope[name];
    if (value === undefined || value === null) {
      throw new Error(missingVariableMessage(name, operation, argName));
    }
    return String(value);
  });
}

function missingVariableMessage(name: string, operation: string, argName: string): string {
  const hint = name === "statusId"
    ? ' (pass "status" in the flow_delegate call and map it in issueTracker.statusMap)'
    : "";
  return `Missing value for "$${name}" needed by host-mediated operation "${operation}" (arg "${argName}")${hint}.`;
}

function referencedVariables(template: string): string[] {
  return [...template.matchAll(VARIABLE_TOKEN)].map((match) => match[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
