import {
  AutoflowService,
  type AutoflowServiceIssueStatus,
  type AutoflowServiceOptions,
  type AutoflowServicePhase,
  type AutoflowServiceStatus,
} from "../src/autoflow-service.js";
import type { PiSessionDriver } from "./pi-session-driver.js";

export type PiAgentOrchestratorPhase = AutoflowServicePhase;
export type PiAgentOrchestratorIssueStatus = AutoflowServiceIssueStatus;
export type PiAgentOrchestratorStatus = AutoflowServiceStatus;

export type PiAgentOrchestratorOptions = Omit<AutoflowServiceOptions, "agentSessionDriver"> & {
  piSessionDriver: PiSessionDriver;
};

export class PiAgentOrchestrator extends AutoflowService {
  constructor(options: PiAgentOrchestratorOptions) {
    const { piSessionDriver, ...serviceOptions } = options;
    super({
      ...serviceOptions,
      agentSessionDriver: piSessionDriver,
    });
  }
}
