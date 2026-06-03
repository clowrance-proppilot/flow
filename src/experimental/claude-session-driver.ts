import {
  AgentSessionDriver,
  type AgentMessageMode,
  type AgentPromptInput,
  type AgentPromptResult,
  type AgentRunner,
  type AgentSessionDriverOptions,
  type AgentSessionLink,
  type AgentSessionSnapshot,
  type AgentSessionStatus,
  type AgentTimelineItem,
} from "./agent-session-driver.js";
import { ClaudeAgentRunner } from "./claude-agent-runner.js";

export const claudeAgentSessionProvider = {
  id: "claude",
  displayName: "Claude",
  stateFilePrefix: "claude",
  defaultSessionId: () => globalThis.crypto.randomUUID(),
  failureMessage: (error: string) => `Claude session failed: ${error}`,
} as const;

export interface ClaudeSessionDriverOptions extends Omit<AgentSessionDriverOptions, "provider" | "agent"> {
  agent?: ClaudeAgentRunner | AgentRunner | false;
}

export type ClaudeSessionLink = AgentSessionLink;
export type ClaudeTimelineItem = AgentTimelineItem;
export type ClaudeSessionSnapshot = AgentSessionSnapshot;
export type ClaudeAgentPromptInput = AgentPromptInput;
export type ClaudeAgentPromptResult = AgentPromptResult;
export type ClaudeAgentMessageMode = AgentMessageMode;
export type ClaudeSessionStatus = AgentSessionStatus;

export class ClaudeSessionDriver extends AgentSessionDriver {
  constructor(options: ClaudeSessionDriverOptions) {
    super({
      ...options,
      provider: claudeAgentSessionProvider,
      agent: options.agent === false ? false : options.agent ?? new ClaudeAgentRunner(),
    });
  }
}
