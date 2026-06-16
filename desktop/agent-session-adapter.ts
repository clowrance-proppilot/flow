import type { ClaudeSessionDriver } from "../src/experimental/claude-session-driver.js";
import type { StandaloneAutoflowRunner } from "../src/experimental/autoflow-runner.js";
import type { DesktopAgentPromptInput, DesktopAgentPromptResult, DesktopAgentSessionAdapter } from "./prompt-router.js";

export interface DesktopAgentSessionAdapterOptions {
  getAgentSessionDriver: () => Promise<ClaudeSessionDriver>;
  getAutoflowRunner: () => Promise<StandaloneAutoflowRunner>;
}

export class DesktopAgentSessionAdapterImpl implements DesktopAgentSessionAdapter {
  private readonly getAgentSessionDriver: () => Promise<ClaudeSessionDriver>;
  private readonly getAutoflowRunner: () => Promise<StandaloneAutoflowRunner>;

  constructor(options: DesktopAgentSessionAdapterOptions) {
    this.getAgentSessionDriver = options.getAgentSessionDriver;
    this.getAutoflowRunner = options.getAutoflowRunner;
  }

  async sendPrompt(input: DesktopAgentPromptInput): Promise<DesktopAgentPromptResult> {
    if (!input.issueRef) {
      return { summary: "Prompt recorded for project context." };
    }

    const agentSessionDriver = await this.getAgentSessionDriver();
    const autoflowRunner = await this.getAutoflowRunner();

    const session = input.sessionId
      ? await agentSessionDriver.getSession(input.sessionId).catch(() => undefined)
      : undefined;

    void autoflowRunner.sendUserMessage({
      issueRef: input.issueRef,
      sessionId: session?.id,
      text: input.prompt,
    }).catch((error: unknown) => {
      console.error("[flow-desktop] agent prompt failed:", error);
    });

    const target = session ?? await agentSessionDriver.openOrCreateIssueSession(input.issueRef);
    const summary = `Prompt sent to ${target.issueRef}.`;

    return {
      session: {
        id: target.id,
        provider: "claude",
        workspacePath: target.workspacePath,
        status: "active",
        summary,
      },
      summary,
    };
  }
}
