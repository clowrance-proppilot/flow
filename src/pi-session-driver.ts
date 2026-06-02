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
import { PiSdkSessionRunner } from "./pi-sdk-runner.js";

export const piAgentSessionProvider = {
  id: "pi",
  displayName: "Pi",
  stateFilePrefix: "pi",
  defaultSessionId: (issueRef: string) => `pi-${issueRef.toLowerCase()}-${Date.now().toString(36)}`,
  failureMessage: (error: string) => `Pi session failed: ${error}`,
} as const;

export interface PiSessionDriverOptions extends Omit<AgentSessionDriverOptions, "provider" | "agent"> {
  agent?: PiAgentRunner | false;
}

export type FlowSessionLink = AgentSessionLink;
export type PiTimelineItem = AgentTimelineItem;
export type PiSessionSnapshot = AgentSessionSnapshot;
export type PiAgentPromptInput = AgentPromptInput;
export type PiAgentPromptResult = AgentPromptResult;
export type PiAgentRunner = AgentRunner;
export type PiSessionStatus = AgentSessionStatus;
export type PiAgentMessageMode = AgentMessageMode;

export class PiSessionDriver extends AgentSessionDriver {
  constructor(options: PiSessionDriverOptions) {
    super({
      ...options,
      provider: piAgentSessionProvider,
      agent: options.agent === false ? false : options.agent ?? new PiSdkSessionRunner(),
    });
  }
}
