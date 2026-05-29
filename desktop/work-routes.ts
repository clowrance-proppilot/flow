import type { Express, RequestHandler } from "express";
import type { DesktopActionRouter } from "./action-router.js";
import { isDesktopAction } from "./action-router.js";
import type { DesktopPromptRouter } from "./prompt-router.js";
import { isPromptTarget, message, requireActiveProject } from "./route-helpers.js";
import type { RouteContext } from "./route-types.js";

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
      const issue = await runtime.createIssue(sessionId, {
        issueType: typeof req.body?.issueType === "string" ? req.body.issueType : "Bug",
        title: typeof req.body?.title === "string" ? req.body.title : undefined,
        summary: typeof req.body?.summary === "string" ? req.body.summary : "",
        description: typeof req.body?.description === "string" ? req.body.description : undefined,
        repoKeys: Array.isArray(req.body?.repoKeys) ? req.body.repoKeys.map(String).filter(Boolean) : undefined,
        branchKind: typeof req.body?.branchKind === "string" ? req.body.branchKind : undefined,
        select: req.body?.select !== false,
      });
      res.json({ ok: true, project, issue });
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/prompt", jsonBody, async (req, res) => {
    try {
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
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
      res.status(400).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/issues/:issueRef/session", async (req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const session = await surface.piSessionDriver.openOrCreateIssueSession(String(req.params.issueRef ?? ""));
      res.json({ ok: true, session });
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error) });
    }
  });

  server.get("/api/sessions/:sessionId/events", async (req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const sessionId = String(req.params.sessionId ?? "");
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
      res.status(404).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/actions/:action", jsonBody, async (req, res) => {
    try {
      const action = String(req.params.action ?? "");
      if (!isDesktopAction(action)) {
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
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const issueRef = String(req.params.issueRef ?? "").trim();
      if (!issueRef) {
        res.status(400).json({ ok: false, error: "Missing issueRef." });
        return;
      }
      const session = await surface.piSessionDriver.startSession(issueRef);
      res.json({ ok: true, session });
    } catch (error) {
      console.error("[flow-desktop] pi session start failed:", error);
      res.status(503).json({ ok: false, error: message(error) });
    }
  });

  server.get("/api/pi/sessions/:sessionId", async (req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const sessionId = String(req.params.sessionId ?? "").trim();
      if (!sessionId) {
        res.status(400).json({ ok: false, error: "Missing sessionId." });
        return;
      }
      const session = await surface.piSessionDriver.getSession(sessionId);
      res.json({ ok: true, session });
    } catch (error) {
      res.status(404).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/pi/sessions/:sessionId/prompts", jsonBody, async (req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const sessionId = String(req.params.sessionId ?? "").trim();
      if (!sessionId) {
        res.status(400).json({ ok: false, error: "Missing sessionId." });
        return;
      }
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
      const session = await surface.piSessionDriver.postPrompt(sessionId, prompt);
      res.json({ ok: true, session });
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error) });
    }
  });
}
