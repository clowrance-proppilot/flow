import { z } from "zod";

export const agentRoleSchema = z.enum(["flow", "work_runtime", "readiness", "executor"]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}
