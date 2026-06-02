import type { Express, RequestHandler } from "express";
import type { DesktopActionRouter } from "./action-router.js";
import { isDesktopAction } from "./action-router.js";
import type { DesktopPromptRouter } from "./prompt-router.js";
import { isPromptTarget, message, requireActiveProject } from "./route-helpers.js";
import type { RouteContext } from "./route-types.js";

const ISSUE_REF_RE = /^[A-Z][A-Z0-9_.-]+-\d+$/i;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_PROMPT_LENGTH = 32_768;
const MAX_TITLE_LENGTH = 1024;
const MAX_DESCRIPTION_LENGTH = 16_384;

function validateIssueRef(value: string): boolean {
  return ISSUE_REF_RE.test(value.trim());
}

function validateSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value.trim()) && value.trim().length <= 256;
}

function validatePromptLength(value: string): boolean {
  return value.length <= MAX_PROMPT_LENGTH;
}

export function registerWorkRoutes(
  server: Express,
  context: RouteContext,
  routers: { promptRouter: DesktopPromptRouter; actionRouter: DesktopActionRouter },
  jsonBody: RequestHandler,
): void {
  const { projectRegistry, projectSurface } = context;
  const { promptRouter, actionRouter } = routers;

  server.post("/api/issues", jsonBody, async (req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const runtime = surface.configured.runtime;
      const sessionId = `desktop-${project.id}`;
      try {
        await runtime.summarizeHandoff(sessionId);
      } catch {
        await runtime.createSession(sessionId);
      }
      const issueType = typeof req.body?.issueType === "string" ? req.body.issueType : "Bug";
      if (!["Bug", "Task", "Story"].includes(issueType)) {
        res.status(400).json({ ok: false, error: "Invalid issueType. Must be Bug, Task, or Story." });
        return;
      }
      const branchKind = typeof req.body?.branchKind === "string" ? req.body.branchKind : undefined;
      if (branchKind !== undefined && branchKind !== "bug" && branchKind !== "feature") {
        res.status(400).json({ ok: false, error: "Invalid branchKind. Must be bug or feature." });
        return;
      }
      const title = typeof req.body?.title === "string" ? req.body.title : undefined;
      if (title && title.length > MAX_TITLE_LENGTH) {
        res.status(400).json({ ok: false, error: `Title exceeds maximum length of ${MAX_TITLE_LENGTH} characters.` });
        return;
      }
      const description = typeof req.body?.description === "string" ? req.body.description : undefined;
      if (description && description.length > MAX_DESCRIPTION_LENGTH) {
        res.status(400).json({ ok: false, error: `Description exceeds maximum length of ${MAX_DESCRIPTION_LENGTH} characters.` });
        return;
      }
      const issueInput = {
        issueType,
        title,
        summary: typeof req.body?.summary === "string" ? req.body.summary : "",
        description,
        repoKeys: Array.isArray(req.body?.repoKeys) ? req.body.repoKeys.map(String).filter(Boolean) : undefined,
        branchKind,
        select: req.body?.select !== false,
      };
      if (req.body?.dryRun === true) {
        const intake = await runtime.intakeIssue(sessionId, { ...issueInput, dryRun: true, review: req.body?.review === true });
        res.json({ ok: true, project, intake });
        return;
      }
      const issue = await runtime.createIssue(sessionId, issueInput);
      res.json({ ok: true, project, issue });
    } catch (error) {
      console.error("[flow-desktop] create issue failed:", error);
      res.status(400).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/prompt", jsonBody, async (req, res) => {
    try {
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
      if (!validatePromptLength(prompt)) {
        res.status(400).json({ ok: false, error: `Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters.` });
        return;
      }
      const result = await promptRouter.submit({
        prompt,
        projectId: typeof req.body?.projectId === "string" ? req.body.projectId : undefined,
        issueRef: typeof req.body?.issueRef === "string" ? req.body.issueRef : undefined,
        threadId: typeof req.body?.threadId === "string" ? req.body.threadId : undefined,
        sessionId: typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined,
        target: isPromptTarget(req.body?.target) ? req.body.target : undefined,
        artifactRefs: Array.isArray(req.body?.artifactRefs) ? req.body.artifactRefs.map(String).filter(Boolean) : undefined,
      });
      res.json(result);
    } catch (error) {
      console.error("[flow-desktop] prompt submission failed:", error);
      res.status(400).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/issues/:issueRef/session", async (req, res) => {
    try {
      const issueRef = String(req.params.issueRef ?? "").trim();
      if (!issueRef || !validateIssueRef(issueRef)) {
        res.status(400).json({ ok: false, error: "Invalid issueRef format." });
        return;
      }
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const session = await surface.piSessionDriver.openOrCreateIssueSession(issueRef);
      res.json({ ok: true, session });
    } catch (error) {
      console.error("[flow-desktop] issue session creation failed:", error);
      res.status(400).json({ ok: false, error: message(error) });
    }
  });

  server.get("/api/sessions/:sessionId/events", async (req, res) => {
    try {
      const sessionId = String(req.params.sessionId ?? "").trim();
      if (!sessionId || !validateSessionId(sessionId)) {
        res.status(400).json({ ok: false, error: "Invalid sessionId format." });
        return;
      }
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      await surface.piSessionDriver.getSession(sessionId);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, sessionId })}\n\n`);
      const unsubscribe = surface.piSessionDriver.subscribe(sessionId, (event) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      req.on("close", unsubscribe);
    } catch (error) {
      console.error("[flow-desktop] session events subscription failed:", error);
      res.status(404).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/actions/:action", jsonBody, async (req, res) => {
    try {
      const action = String(req.params.action ?? "").trim();
      if (!action || !isDesktopAction(action)) {
        res.status(404).json({ ok: false, error: "Unknown desktop action." });
        return;
      }
      const result = await actionRouter.invoke({
        action,
        projectId: typeof req.body?.projectId === "string" ? req.body.projectId : undefined,
        issueRef: typeof req.body?.issueRef === "string" ? req.body.issueRef : undefined,
        payload: typeof req.body?.payload === "object" && req.body.payload !== null ? req.body.payload : {},
      });
      res.json(result);
    } catch (error) {
      console.error("[flow-desktop] desktop action failed:", error);
      res.status(400).json({ ok: false, error: message(error) });
    }
  });

  server.get("/api/autoflow/status", async (_req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      res.json({ ok: true, status: await surface.autoflowRunner.status() });
    } catch (error) {
      console.error("[flow-desktop] autoflow status failed:", error);
      res.status(400).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/autoflow/tick", async (_req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const status = await surface.autoflowRunner.tick();
      res.json({ ok: true, status });
    } catch (error) {
      console.error("[flow-desktop] autoflow tick failed:", error);
      res.status(400).json({ ok: false, error: message(error) });
    }
  });

  server.get("/api/pi/issues", async (_req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const payload = await surface.dashboardState.payload({ limit: 50 });
      res.json({
        ok: true,
        project,
        issues: Array.isArray(payload.issues) ? payload.issues : [],
      });
    } catch (error) {
      console.error("[flow-desktop] pi issue list failed:", error);
      res.status(503).json({ ok: false });
    }
  });

  server.post("/api/pi/issues/:issueRef/session", async (req, res) => {
    try {
      const issueRef = String(req.params.issueRef ?? "").trim();
      if (!issueRef || !validateIssueRef(issueRef)) {
        res.status(400).json({ ok: false, error: "Invalid issueRef format." });
        return;
      }
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const session = await surface.piSessionDriver.startSession(issueRef);
      res.json({ ok: true, session });
    } catch (error) {
      console.error("[flow-desktop] pi session start failed:", error);
      res.status(503).json({ ok: false, error: message(error) });
    }
  });

  server.get("/api/pi/sessions/:sessionId", async (req, res) => {
    try {
      const sessionId = String(req.params.sessionId ?? "").trim();
      if (!sessionId || !validateSessionId(sessionId)) {
        res.status(400).json({ ok: false, error: "Invalid sessionId format." });
        return;
      }
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const session = await surface.piSessionDriver.getSession(sessionId);
      res.json({ ok: true, session });
    } catch (error) {
      console.error("[flow-desktop] pi session fetch failed:", error);
      res.status(404).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/pi/sessions/:sessionId/prompts", jsonBody, async (req, res) => {
    try {
      const sessionId = String(req.params.sessionId ?? "").trim();
      if (!sessionId || !validateSessionId(sessionId)) {
        res.status(400).json({ ok: false, error: "Invalid sessionId format." });
        return;
      }
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
      if (!validatePromptLength(prompt)) {
        res.status(400).json({ ok: false, error: `Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters.` });
        return;
      }
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const current = await surface.piSessionDriver.getSession(sessionId);
      const session = await surface.autoflowRunner.sendUserMessage({
        issueRef: current.issueRef,
        sessionId,
        text: prompt,
      });
      res.json({ ok: true, session });
    } catch (error) {
      console.error("[flow-desktop] pi prompt post failed:", error);
      res.status(400).json({ ok: false, error: message(error) });
    }
  });
}
