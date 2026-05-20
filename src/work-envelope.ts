import { workEnvelopeSchema, type WorkEnvelope } from "./contracts.js";

export function parseWorkEnvelope(input: string): WorkEnvelope {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(input.trim());
  if (!match) {
    throw new Error("Work envelope must start with YAML frontmatter delimited by ---.");
  }
  const frontmatter = parseSimpleYaml(match[1]);
  const body = match[2].trim();
  return workEnvelopeSchema.parse({
    ...frontmatter,
    body,
  });
}

function parseSimpleYaml(input: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }];

  for (const rawLine of input.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const line = rawLine.trim();
    const separator = line.indexOf(":");
    if (separator === -1) throw new Error(`Invalid work envelope frontmatter line: ${line}`);

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!key) throw new Error(`Invalid work envelope frontmatter key: ${line}`);

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].value;
    if (!rawValue) {
      const nested: Record<string, unknown> = {};
      parent[key] = nested;
      stack.push({ indent, value: nested });
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }

  return root;
}

function parseScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  const quoted = /^["']([\s\S]*)["']$/.exec(value);
  if (quoted) return quoted[1];
  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1).trim();
    return body ? body.split(",").map((item) => parseScalar(item.trim())) : [];
  }
  return value;
}
