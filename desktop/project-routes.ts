import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Express, RequestHandler } from "express";
import { message, requireActiveProject, summarizeProjectIssues } from "./route-helpers.js";
import type { RouteContext } from "./route-types.js";

const PROJECT_ID_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_PROJECT_ROOT_LENGTH = 4096;

function validateProjectId(value: string): boolean {
  return PROJECT_ID_RE.test(value) && value.length <= 256;
}

function validateProjectRoot(value: string): boolean {
  return value.length > 0 && value.length <= MAX_PROJECT_ROOT_LENGTH;
}

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
        const autoflowStatus = await surface.autoflowRunner.status();
        const payload = await surface.dashboardState.payload({ limit: 50 });
        const summary = summarizeProjectIssues(payload.issues);
        return {
          ...publicProject,
          autoflowEnabled: autoflowStatus.enabled,
          attentionCount: summary.blocked + summary.needsInput,
          statusCounts: summary,
        };
      } catch (error) {
        console.error(`[flow-desktop] project summary failed for ${project.id}:`, error);
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
      const projectId = String(req.params.projectId ?? "");
      if (!projectId || !validateProjectId(projectId)) {
        res.status(400).json({ ok: false, error: "Invalid projectId format." });
        return;
      }
      const project = (await projectRegistry.listProjects()).find((candidate) => candidate.id === projectId);
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
      console.error("[flow-desktop] project icon fetch failed:", error);
      res.status(400).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/projects", jsonBody, async (req, res) => {
    try {
      const root = typeof req.body?.root === "string" ? req.body.root.trim() : "";
      if (!root || !validateProjectRoot(root)) {
        res.status(400).json({ ok: false, error: "Missing or invalid project root." });
        return;
      }
      const project = await projectRegistry.addProject(root);
      invalidateProjectSurface?.(project.id);
      res.json({ ok: true, activeProjectId: project.id, project, projects: await projectRegistry.listProjects() });
    } catch (error) {
      console.error("[flow-desktop] add project failed:", error);
      res.status(400).json({ ok: false, error: message(error) });
    }
  });

  server.delete("/api/projects/:projectId", async (req, res) => {
    try {
      const projectId = String(req.params.projectId ?? "");
      if (!projectId || !validateProjectId(projectId)) {
        res.status(400).json({ ok: false, error: "Invalid projectId format." });
        return;
      }
      await projectRegistry.removeProject(projectId);
      invalidateProjectSurface?.(projectId);
      const projects = await projectRegistry.listProjects();
      const active = await projectRegistry.activeProject();
      res.json({ ok: true, activeProjectId: active?.id, projects });
    } catch (error) {
      console.error("[flow-desktop] remove project failed:", error);
      res.status(404).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/projects/:projectId/active", async (req, res) => {
    try {
      const projectId = String(req.params.projectId ?? "");
      if (!projectId || !validateProjectId(projectId)) {
        res.status(400).json({ ok: false, error: "Invalid projectId format." });
        return;
      }
      const project = await projectRegistry.setActiveProject(projectId);
      res.json({ ok: true, project });
    } catch (error) {
      console.error("[flow-desktop] set active project failed:", error);
      res.status(404).json({ ok: false, error: message(error) });
    }
  });

  server.post("/api/projects/:projectId/autoflow", jsonBody, async (req, res) => {
    try {
      const enabled = req.body?.enabled !== false;
      const projectId = String(req.params.projectId ?? "");
      if (!projectId || !validateProjectId(projectId)) {
        res.status(400).json({ ok: false, error: "Invalid projectId format." });
        return;
      }
      const project = (await projectRegistry.listProjects()).find((candidate) => candidate.id === projectId);
      if (!project) throw new Error(`Unknown Flow project ${projectId}.`);
      const surface = await projectSurface(project);
      const status = await surface.autoflowRunner.setEnabled(enabled);
      res.json({ ok: true, project: { ...project, autoflowEnabled: status.enabled } });
    } catch (error) {
      console.error("[flow-desktop] set project autoflow failed:", error);
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
      const repoKeys = Object.keys(surface.configured.flowConfig?.topology?.repos ?? {});
      res.json({ ok: true, project, dashboard, context: ledgerContext, repoKeys });
    } catch (error) {
      console.error("[flow-desktop] context snapshot failed:", error);
      res.status(503).json({ ok: false, error: message(error) });
    }
  });
}
