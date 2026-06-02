import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const runtimeDir = resolve(import.meta.dirname);

function resolveFlowRoot(): string {
  let cursor = runtimeDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(cursor);
    if (existsSync(join(candidate, "package.json")) && existsSync(join(candidate, "src")) && existsSync(join(candidate, "bin"))) {
      return candidate;
    }
    cursor = resolve(cursor, "..");
  }
  return resolve(runtimeDir, "../..");
}

export const flowRoot = resolveFlowRoot();
export const repoRoot = resolve(process.env.FLOW_ROOT || process.cwd());
