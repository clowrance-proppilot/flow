import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Express, RequestHandler } from "express";
import { message, requireActiveProject, summarizeProjectIssues } from "./route-helpers.js";
import type { RouteContext } from "./route-types.js";

export function registerProjectRoutes(server: Express, context: RouteContext, jsonBody: RequestHandler): void {
  const { projectRegistry, projectSurface, invalidateProjectSurface } = context;

  server.get("/healthz", (_req, res) => res.json({ ok: true }));

  server.get("/api/dashboard", async (_req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const payload = await surface.dashboardState.payload({ limit: 50 });
      res.json(payload);
    } catch (error) {
      console.error("[flow-desktop] dashboard snapshot failed:", error);
      res.status(503).json({ ok: false });
    }
  });

  server.get("/api/projects", async (_req, res) => {
    const active = await projectRegistry.activeProject();
    const projects = await projectRegistry.listProjects();
    const projectsWithSummary = await Promise.all(projects.map(async (project) => {
      const publicProject = {
        ...project,
        icon: project.icon ? `/api/projects/${encodeURIComponent(project.id)}/icon` : undefined,
      };
      try {
        const surface = await projectSurface(project);
        const payload = await surface.dashboardState.payload({ limit: 50 });
        const summary = summarizeProjectIssues(payload.issues);
        return {
          ...publicProject,
          attentionCount: summary.blocked + summary.needsInput,
          statusCounts: summary,
        };
      } catch {
        return {
          ...publicProject,
          attentionCount: 0,
          statusCounts: summarizeProjectIssues(undefined),
        };
      }
    }));
    res.json({
      ok: true,
      activeProjectId: active?.id,
      projects: projectsWithSummary,
    });
  });

  server.get("/api/projects/:projectId/icon", async (req, res) => {
    try {
      const project = (await projectRegistry.listProjects()).find((candidate) => candidate.id === String(req.params.projectId ?? ""));
      if (!project?.icon) {
        res.status(404).end();
        return;
      }
      const projectRoot = resolve(project.root);
      const iconPath = resolve(projectRoot, project.icon);
      const relativeIconPath = relative(projectRoot, iconPath);
      if (relativeIconPath.startsWith("..") || relativeIconPath === "" || relativeIconPath.includes(":")) {
        res.status(400).json({ ok: false, error: "Project icon must stay inside the project root." });
        return;
      }
      if (!existsSync(iconPath)) {
        res.status(404).end();
        return;
      }
      res.sendFile(iconPath);
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/projects", jsonBody, async (req, res) => {
    try {
      const root = typeof req.body?.root === "string" ? req.body.root : "";
      if (!root.trim()) {
        res.status(400).json({ ok: false, error: "Missing project root." });
        return;
      }
      const project = await projectRegistry.addProject(root);
      invalidateProjectSurface?.(project.id);
      res.json({ ok: true, activeProjectId: project.id, project, projects: await projectRegistry.listProjects() });
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/projects/:projectId/active", async (req, res) => {
    try {
      const project = await projectRegistry.setActiveProject(String(req.params.projectId ?? ""));
      res.json({ ok: true, project });
    } catch (error) {
      res.status(404).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/projects/:projectId/autoflow", jsonBody, async (req, res) => {
    try {
      const enabled = req.body?.enabled !== false;
      const project = await projectRegistry.setProjectAutoflow(String(req.params.projectId ?? ""), enabled);
      invalidateProjectSurface?.(project.id);
      res.json({ ok: true, project });
    } catch (error) {
      res.status(404).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/projects/:projectId/confirmations", jsonBody, async (req, res) => {
    try {
      const disabled = req.body?.disabled === true;
      const project = await projectRegistry.setProjectConfirmations(String(req.params.projectId ?? ""), disabled);
      res.json({ ok: true, project });
    } catch (error) {
      res.status(404).json({ ok: false, error: message(error) });
    }
  });

  server.get("/api/context", async (_req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const dashboard = await surface.dashboardState.payload({ limit: 50 });
      const ledgerContext = surface.configured.workflowLedger.readContext
        ? await surface.configured.workflowLedger.readContext({ projectId: project.id })
        : undefined;
      res.json({ ok: true, project, dashboard, context: ledgerContext });
    } catch (error) {
      res.status(503).json({ ok: false, error: message(error) });
    }
  });
}
