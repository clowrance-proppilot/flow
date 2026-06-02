import type { PiSessionDriver } from "../src/pi-session-driver.js";
import type { StandaloneAutoflowRunner } from "../src/experimental/autoflow-runner.js";
import type { DesktopAgentPromptInput, DesktopAgentPromptResult, DesktopAgentSessionAdapter } from "./prompt-router.js";

export interface DesktopAgentSessionAdapterOptions {
  getPiSessionDriver: () => Promise<PiSessionDriver>;
  getAutoflowRunner: () => Promise<StandaloneAutoflowRunner>;
}

export class DesktopAgentSessionAdapterImpl implements DesktopAgentSessionAdapter {
  private readonly getPiSessionDriver: () => Promise<PiSessionDriver>;
  private readonly getAutoflowRunner: () => Promise<StandaloneAutoflowRunner>;

  constructor(options: DesktopAgentSessionAdapterOptions) {
    this.getPiSessionDriver = options.getPiSessionDriver;
    this.getAutoflowRunner = options.getAutoflowRunner;
  }

  async sendPrompt(input: DesktopAgentPromptInput): Promise<DesktopAgentPromptResult> {
    if (!input.issueRef) {
      return { summary: "Prompt recorded for project context." };
    }

    const piSessionDriver = await this.getPiSessionDriver();
    const autoflowRunner = await this.getAutoflowRunner();

    const session = input.sessionId
      ? await piSessionDriver.getSession(input.sessionId).catch(() => undefined)
      : undefined;

    void autoflowRunner.sendUserMessage({
      issueRef: input.issueRef,
      sessionId: session?.id,
      text: input.prompt,
    }).catch((error: unknown) => {
      console.error("[flow-desktop] pi prompt failed:", error);
    });

    const target = session ?? await piSessionDriver.openOrCreateIssueSession(input.issueRef);
    const summary = `Prompt sent to ${target.issueRef}.`;

    return {
      session: {
        id: target.id,
        provider: "pi",
        workspacePath: target.workspacePath,
        status: "active",
        summary,
      },
      summary,
    };
  }
}
