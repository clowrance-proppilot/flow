import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

import {
  FlowWorkRuntime,
  FlowStore,
  MemoryWorkflowLedger,
  MirroredWorkflowLedger,
  assessIssue,
  extractAutoReviewFeedback,
  nowIso,
  beadUpdateArgsForIssue,
  workItemToBeadsMetadata,
  workJobResultSchema,
  workJobSchema,
  parseWorkEnvelope,
  createDefaultFlowWorkTypeRegistry,
  createWorkflowLedger,
  verifyJsonlWorkflowLedger,
  bootstrapFlowConfig,
  configToProjectTopology,
  configToWorkTypeRegistry,
  flowConfigPath,
  flowContextProjectionPath,
  flowIssueProjectionPath,
  flowContextRecordSchema,
  flowUserConfigPath,
  flowUserRuntimePath,
  flowConfigSchema,
  loadFlowConfig,
  migrateFlowConfig,
  validateFlowConfig,
  LocalThreadExecutor,
  LocalIssueTrackerAdapter,
  NoopCodeCollaborationAdapter,
  ProviderAdapterError,
  classifyProviderCliError,
} from "../src/index.js";
import type { ProjectTopology } from "../src/project-topology.js";
import { parseGitHubIssues, parsePullRequests } from "../src/adapters/github.js";
import { currentUserBacklogJql, currentUserOpenSprintJql, parseJiraCommentUrl, parseJiraIssue, parseJiraSearch } from "../src/adapters/jira.js";
import { DesktopActionRouter } from "../desktop/action-router.js";
import { PiAgentOrchestrator } from "../desktop/pi-agent-orchestrator.js";
import { PiSessionDriver } from "../desktop/pi-session-driver.js";
import { PiSdkSessionRunner } from "../desktop/pi-sdk-runner.js";
import { DesktopProjectRegistry } from "../desktop/project-registry.js";
import { DesktopPromptRouter } from "../desktop/prompt-router.js";
import { projectThemeFor } from "../src/theme/project-theme.js";

const execFileAsync = promisify(execFile);

const legacyHostConfig = flowConfigSchema.parse({
  version: "1",
  project: { name: "Legacy Host Fixture" },
  topology: {
    repos: {
      main: { name: "HostProject", baseBranch: "main" },
      web_app: { name: "web-app", baseBranch: "develop", pathFromRoot: "web-app" },
      mobile_app: { name: "mobile-app", baseBranch: "develop", pathFromRoot: "mobile-app" },
      public_api: { name: "public-api", baseBranch: "develop", pathFromRoot: "public-api" },
      app_api: { name: "app-api", baseBranch: "develop", pathFromRoot: "app-api" },
      core_database: { name: "core-database", baseBranch: "develop", pathFromRoot: "core-database" },
    },
    branchPattern: "{kind}/{issueRef}-{slug}",
    pullRequestUrlPattern: "https://github.com/ExampleOrg/{repoName}/pull/{number}",
    issueInference: [
      { repo: "main", keywords: ["flow", "workflow workRuntime", "worker executor"] },
      { repo: "web_app", keywords: ["web-app", "pwa", "frontend", "react", "vite", "browser ui"] },
      { repo: "mobile_app", keywords: ["mobile-app", "ios", "swift", "xcode", "iphone"] },
      { repo: "public_api", keywords: ["public-api", "public api", "request-export", "endpoint contract", "nx workspace"] },
      { repo: "app_api", keywords: ["app-api", "provider", "agi", "partnercloud", "partner", "celery", "controller data", "controller-data", "pixi", "flask"] },
      { repo: "core_database", keywords: ["core-database", "stored procedure", "sproc", "sql revision", "sql trigger"] },
    ],
  },
  issueTracker: { type: "jira", projectKey: "ISSUE", siteUrl: "https://example.atlassian.net" },
  collaboration: { type: "github", owner: "ExampleOrg" },
});
const legacyHostTopology = configToProjectTopology(legacyHostConfig);

function testWorkRuntime(options: ConstructorParameters<typeof FlowWorkRuntime>[0]): FlowWorkRuntime {
  return new FlowWorkRuntime({
    topology: legacyHostTopology,
    defaultJiraProjectKey: configString(legacyHostConfig.issueTracker, "projectKey"),
    ...options,
  });
}

function configString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function commandPath(command: string): Promise<string> {
  const finder = process.platform === "win32" ? "where" : "which";
  const { stdout } = await execFileAsync(finder, [command]);
  const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!first) throw new Error(`Could not resolve ${command}.`);
  return first;
}

test("Typed work contracts and registry validate supported jobs", () => {
  const workTypes = createDefaultFlowWorkTypeRegistry();
  const now = nowIso();
  const job = workJobSchema.parse({
    id: "job-1",
    issueRef: "ISSUE-1",
    repoKey: "app_api",
    workType: "flow.implement",
    status: "queued",
    input: { prompt: "fix it" },
    createdAt: now,
    updatedAt: now,
  });
  const result = workJobResultSchema.parse({
    jobId: job.id,
    issueRef: job.issueRef,
    repoKey: job.repoKey,
    workType: job.workType,
    status: "succeeded",
    summary: "Implemented",
    evidence: ["npm test"],
    completedAt: now,
  });

  assert.equal(workTypes.get(job.workType)?.outputType, "worker_result");
  assert.equal(workTypes.executorCanRun("live_agent_thread", job.workType, job.requiredCapabilities), true);
  assert.equal(workTypes.executorCanRun("background_worker", job.workType, job.requiredCapabilities), false);
  assert.equal(result.jobId, job.id);
  assert.equal(workTypes.has("flow.unknown"), false);
});

test("Work type definitions include category metadata", () => {
  const workTypes = createDefaultFlowWorkTypeRegistry();
  assert.equal(workTypes.get("flow.prepare_workspace")?.category, "prepare");
  assert.equal(workTypes.get("flow.implement")?.category, "implement");
  assert.equal(workTypes.get("flow.remediate")?.category, "remediate");
  assert.equal(workTypes.get("flow.verify")?.category, "verify");

  assert.equal(workTypes.isCodeProducing("flow.implement"), true);
  assert.equal(workTypes.isCodeProducing("flow.remediate"), true);
  assert.equal(workTypes.isCodeProducing("flow.prepare_workspace"), false);
  assert.equal(workTypes.isCodeProducing("flow.verify"), false);

  assert.equal(workTypes.workTypeForCategory("implement"), "flow.implement");
  assert.equal(workTypes.workTypeForCategory("remediate"), "flow.remediate");
  assert.equal(workTypes.workTypeForCategory("prepare"), "flow.prepare_workspace");
  assert.equal(workTypes.workTypeForCategory("verify"), "flow.verify");
});

test("Flow config schema validates topology and adapter declarations", () => {
  const config = flowConfigSchema.parse({
    version: "1",
    project: { name: "Example", icon: "./assets/example.svg" },
    topology: {
      repos: {
        main: { name: "example", baseBranch: "main" },
      },
      issueInference: [{ repo: "main", keywords: ["frontend"] }],
    },
    issueTracker: { type: "github", owner: "example", repo: "example" },
    collaboration: { type: "github", owner: "example" },
  });

  assert.equal(config.project.name, "Example");
  assert.equal(config.project.icon, "./assets/example.svg");
  assert.equal(config.issueTracker?.type, "github");
  assert.equal(config.topology.issueInference[0].repo, "main");

  const localConfig = flowConfigSchema.parse({
    version: "1",
    project: { name: "Local Example" },
    topology: {
      repos: {
        main: { name: "example", baseBranch: "main" },
      },
    },
    issueTracker: { type: "local", prefix: "LOCAL" },
    collaboration: { type: "none" },
    sourceControl: { type: "git" },
    ledger: { type: "flow" },
  });
  assert.equal(localConfig.issueTracker?.type, "local");
  assert.equal(localConfig.collaboration?.type, "none");

  assert.throws(() =>
    flowConfigSchema.parse({
      version: "1",
      project: { name: "Bad" },
      topology: {
        repos: { main: { name: "example" } },
        issueInference: [{ repo: "missing", keywords: ["oops"] }],
      },
    })
  );
  assert.throws(() =>
    flowConfigSchema.parse({
      version: "1",
      project: { name: "Bad branch pattern" },
      topology: {
        repos: { main: { name: "example" } },
        branchPattern: "feature/{slug}",
      },
    }),
    /branchPattern must include/,
  );
  assert.throws(() =>
    flowConfigSchema.parse({
      version: "1",
      project: { name: "Bad GitHub labels" },
      topology: {
        repos: { main: { name: "example" } },
      },
      issueTracker: { type: "github", owner: "example", repo: "example", activeLabels: ["ready", ""] },
    }),
    /activeLabels must be an array/,
  );
});

test("Flow config loader reads YAML and builds topology", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-config-"));
  await mkdir(dirname(flowConfigPath(root)), { recursive: true });
  await writeFile(flowConfigPath(root), [
    'version: "1"',
    "project:",
    '  name: "Example"',
    "topology:",
    "  repos:",
    "    main:",
    '      name: "example"',
    '      baseBranch: "main"',
    "    api:",
    '      name: "example-api"',
    '      baseBranch: "develop"',
    '      pathFromRoot: "services/api"',
    '  branchPattern: "{kind}/{issueRef}-{slug}"',
    '  pullRequestUrlPattern: "https://github.com/example/{repoName}/pull/{number}"',
    "  issueInference:",
    "    - repo: api",
    '      keywords: ["api", "backend"]',
    "issueTracker:",
    '  type: "github"',
    '  owner: "example"',
    '  repo: "example"',
    "",
  ].join("\n"));

  const config = await loadFlowConfig({ projectRoot: root });
  assert.ok(config);
  const topology = configToProjectTopology(config);
  assert.equal(topology.repoName("api"), "example-api");
  assert.equal(topology.repoPath(root, "api"), `${root.replace(/\\/g, "/")}/services/api`);
  assert.equal(topology.defaultBaseBranch("api"), "develop");
  assert.equal(topology.pullRequestUrl("example-api", 42), "https://github.com/example/example-api/pull/42");
  assert.deepEqual(topology.inferRepoKeysFromIssue({ title: "Fix backend endpoint", labels: [] }), ["api"]);
  assert.equal(topology.branchName({
    ref: "ABC-123",
    title: "ABC-123 Fix backend endpoint",
    repoKeys: ["api"],
    state: "queued",
    metadata: { jiraIssueType: "Bug" },
  }), "bug/abc-123-fix-backend-endpoint");
});

test("Flow config validator returns machine-readable diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-config-"));
  await mkdir(dirname(flowConfigPath(root)), { recursive: true });
  await writeFile(flowConfigPath(root), [
    'version: "1"',
    "project:",
    '  name: "Broken"',
    "topology:",
    "  repos:",
    "    main:",
    '      name: "example"',
    '  branchPattern: "feature/{slug}"',
  ].join("\n"), "utf8");

  const result = await validateFlowConfig({ projectRoot: root });

  assert.equal(result.ok, false);
  assert.equal(result.path, flowConfigPath(root));
  assert.match(result.errors.join("\n"), /branchPattern must include/);
  assert.equal(result.config, undefined);
});

test("Flow config migrate reports current version as no-op", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-config-migrate-current-"));
  await mkdir(dirname(flowConfigPath(root)), { recursive: true });
  await writeFile(flowConfigPath(root), [
    'version: "1"',
    "project:",
    '  name: "Example"',
    "topology:",
    "  repos:",
    "    main:",
    '      name: "example"',
    '      baseBranch: "main"',
    "",
  ].join("\n"), "utf8");

  const result = await migrateFlowConfig({ projectRoot: root });

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.wrote, false);
  assert.equal(result.fromVersion, "1");
  assert.equal(result.toVersion, "1");
  assert.equal(result.errors.length, 0);
});

test("Flow config migrate can add missing version metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-config-migrate-versionless-"));
  await mkdir(dirname(flowConfigPath(root)), { recursive: true });
  await writeFile(flowConfigPath(root), [
    "project:",
    '  name: "Example"',
    "topology:",
    "  repos:",
    "    main:",
    '      name: "example"',
    '      baseBranch: "main"',
    "",
  ].join("\n"), "utf8");

  const preview = await migrateFlowConfig({ projectRoot: root });
  assert.equal(preview.ok, true);
  assert.equal(preview.changed, true);
  assert.equal(preview.wrote, false);
  assert.equal(preview.fromVersion, "0");
  assert.equal(preview.toVersion, "1");

  const beforeWrite = await readFile(flowConfigPath(root), "utf8");
  assert.equal(beforeWrite.includes('version: "1"'), false);

  const written = await migrateFlowConfig({ projectRoot: root, write: true });
  assert.equal(written.ok, true);
  assert.equal(written.changed, true);
  assert.equal(written.wrote, true);

  const afterWrite = await readFile(flowConfigPath(root), "utf8");
  assert.match(afterWrite, /version:\s*"1"/);

  const validation = await validateFlowConfig({ projectRoot: root });
  assert.equal(validation.ok, true);
});

test("Flow config bootstrap creates hidden user-state config by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-bootstrap-"));
  const home = await mkdtemp(join(tmpdir(), "flow-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const result = await bootstrapFlowConfig({ projectRoot: root });

    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.storage, "user");
    assert.equal(result.path, flowUserConfigPath(root));
    assert.equal(result.repoName, result.projectName);

    const config = await loadFlowConfig({ projectRoot: root });
    assert.ok(config);
    assert.equal(config.project.name, result.projectName);
    assert.equal(config.topology.repos.main.name, result.repoName);
    assert.equal(config.topology.repos.main.baseBranch, "main");
    assert.equal(config.issueTracker?.type, "local");
    assert.equal(config.collaboration?.type, "none");
    assert.equal(config.sourceControl?.type, "git");
    assert.equal(config.ledger?.type, "flow");
    assert.equal(config.runtime?.stateDir, flowUserRuntimePath(root));

    await assert.rejects(
      () => bootstrapFlowConfig({ projectRoot: root }),
      /Flow config already exists/,
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("Flow config bootstrap can create tracked repo config", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-bootstrap-tracked-"));
  const result = await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.storage, "repo-tracked");
  assert.equal(result.path, flowConfigPath(root));
});

test("Flow config bootstrap keeps providers local when a GitHub remote exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-bootstrap-github-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:example-org/example.git"], { cwd: root });

  const result = await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  const config = await loadFlowConfig({ projectRoot: root });

  assert.ok(config);
  assert.equal(result.owner, undefined);
  assert.equal(config.topology.repos.main.name, "example");
  assert.equal(config.issueTracker?.type, "local");
  assert.equal(config.collaboration?.type, "none");
  assert.equal(config.sourceControl?.type, "git");
});

test("Flow CLI core works with only git available on PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-git-only-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const gitPath = await commandPath("git");
  const gitOnlyPath = dirname(gitPath);
  const env = {
    ...process.env,
    PATH: gitOnlyPath,
    Path: gitOnlyPath,
  };
  const flowBin = join(process.cwd(), "bin", "flow");
  const callFlow = async (body: Record<string, unknown>) => {
    const { stdout } = await execFileAsync(process.execPath, [flowBin, JSON.stringify(body)], {
      cwd: root,
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; result?: unknown; error?: unknown };
    if (parsed.ok === false) throw new Error(`Flow CLI failed: ${JSON.stringify(parsed.error)}`);
    return parsed.result as Record<string, unknown>;
  };

  await callFlow({ op: "bootstrap", storage: "repo-tracked" });
  const config = await loadFlowConfig({ projectRoot: root });
  assert.equal(config?.issueTracker?.type, "local");
  assert.equal(config?.collaboration?.type, "none");
  assert.equal(config?.sourceControl?.type, "git");
  assert.equal(config?.runtime && "worker" in config.runtime, false);

  const issue = await callFlow({
    op: "issue",
    mode: "create",
    summary: "Git-only Flow core",
    issueType: "Task",
  });
  assert.equal(issue.title, "Git-only Flow core");

  const manifest = await callFlow({ op: "manifest", target: "issue" });
  const issueTrackerManifest = manifest.issueTracker as Record<string, unknown>;
  assert.deepEqual(manifest.modes, ["view", "select", "create", "route", "adoptBranch", "adoptWorkspace"]);
  assert.equal(issueTrackerManifest.type, "local");
  assert.match(String(issueTrackerManifest.refHint), /^FLOW-GIT-ONLY-[A-Z0-9]+-123$/);
  assert.equal(issueTrackerManifest.sourceOfTruth, ".flow/config.yaml");
  assert.deepEqual(issueTrackerManifest.capabilities, {
    view: true,
    queue: true,
    backlog: true,
    create: true,
    transition: true,
    comments: true,
    planningLane: false,
  });

  const viewed = await callFlow({ op: "issue", mode: "view", id: issue.ref });
  assert.equal(viewed.ref, issue.ref);
  assert.equal(viewed.title, "Git-only Flow core");
});

test("Flow workflow doctor strict mode exits nonzero when readiness is not ok", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-doctor-strict-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const flowCli = join(process.cwd(), ".tmp", "test", "src", "flow.js");

  const callFlow = async (body: Record<string, unknown>) => {
    const encoded = JSON.stringify(body);
    try {
      const { stdout } = await execFileAsync(process.execPath, [flowCli, encoded], {
        cwd: root,
        maxBuffer: 20 * 1024 * 1024,
      });
      return { exitCode: 0, payload: JSON.parse(stdout) as Record<string, unknown> };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string };
      return {
        exitCode: failed.code ?? 1,
        payload: failed.stdout ? JSON.parse(failed.stdout) as Record<string, unknown> : {},
      };
    }
  };

  const bootstrap = await callFlow({ op: "bootstrap", storage: "repo-tracked" });
  assert.equal(bootstrap.exitCode, 0);
  assert.equal(bootstrap.payload.ok, true);

  const created = await callFlow({
    op: "issue",
    mode: "create",
    summary: "Strict doctor check",
    issueType: "Task",
  });
  assert.equal(created.exitCode, 0);
  assert.equal(created.payload.ok, true);
  const issue = created.payload.result as { ref: string };
  assert.ok(issue.ref);

  const doctor = await callFlow({
    op: "workflow",
    mode: "doctor",
    id: issue.ref,
  });
  assert.equal(doctor.exitCode, 0);
  assert.equal(doctor.payload.ok, true);

  const strict = await callFlow({
    op: "workflow",
    mode: "doctor",
    id: issue.ref,
    strict: true,
  });
  assert.notEqual(strict.exitCode, 0);
  assert.equal(strict.payload.ok, false);
  const error = strict.payload.error as { code: string; details?: Record<string, unknown> };
  assert.equal(error.code, "DOCTOR_STRICT_FAILED");
  assert.equal(error.details?.status, "blocked");
});

test("Flow config bootstrap can keep repo-local config in local git exclude", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-bootstrap-untracked-"));
  await execFileAsync("git", ["init"], { cwd: root });

  const result = await bootstrapFlowConfig({ projectRoot: root, storage: "repo-untracked" });
  const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");

  assert.equal(result.storage, "repo-untracked");
  assert.equal(result.path, flowConfigPath(root));
  assert.equal(result.localExcludeUpdated, true);
  assert.match(exclude, /^\.flow\/$/m);
});

test("Desktop project registry tracks active Flow projects from config roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-desktop-project-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "flow-desktop-project-two-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["init"], { cwd: secondRoot });
  await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  await bootstrapFlowConfig({ projectRoot: secondRoot, storage: "repo-tracked" });
  const stateRoot = await mkdtemp(join(tmpdir(), "flow-desktop-state-"));
  const registry = new DesktopProjectRegistry({ statePath: join(stateRoot, "projects.json") });

  const project = await registry.addProject(root);
  const secondProject = await registry.addProject(secondRoot);
  const projects = await registry.listProjects();
  const active = await registry.activeProject();
  const reactivated = await registry.setActiveProject(project.id);

  assert.equal(project.valid, true);
  assert.equal(project.root, root);
  assert.equal(project.configPath, flowConfigPath(root));
  assert.equal(projects.length, 2);
  assert.equal(active?.id, secondProject.id);
  assert.equal(reactivated.id, project.id);
  assert.equal((await registry.activeProject())?.id, project.id);
});

test("Project theme generates stable colors and initials", () => {
  const theme = projectThemeFor({ id: "flow-123", name: "Flow Desktop", root: "C:/repo/flow" });
  const repeated = projectThemeFor({ id: "flow-123", name: "Flow Desktop", root: "C:/repo/flow" });
  const withIcon = projectThemeFor({ id: "flow-123", name: "Flow Desktop", icon: "./assets/flow.svg" });

  assert.equal(theme.initials, "FD");
  assert.equal(theme.color, repeated.color);
  assert.match(theme.color, /^#[0-9a-f]{6}$/i);
  assert.equal(withIcon.iconUrl, "./assets/flow.svg");
});

test("Desktop project registry hides stale project records without config files", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-desktop-project-live-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  const stateRoot = await mkdtemp(join(tmpdir(), "flow-desktop-state-stale-"));
  const statePath = join(stateRoot, "projects.json");
  const registry = new DesktopProjectRegistry({ statePath });
  const project = await registry.addProject(root);
  const staleRoot = join(tmpdir(), "flow-desktop-smoke-stale");

  await writeFile(statePath, `${JSON.stringify({
    activeProjectId: "stale",
    projects: [
      {
        id: "stale",
        name: "desktop-smoke",
        root: staleRoot,
        configPath: join(staleRoot, ".flow", "config.yaml"),
        valid: true,
        addedAt: nowIso(),
        lastOpenedAt: nowIso(),
      },
      project,
    ],
  }, null, 2)}\n`, "utf8");

  const projects = await registry.listProjects();
  const active = await registry.activeProject();

  assert.deepEqual(projects.map((candidate) => candidate.id), [project.id]);
  assert.equal(active?.id, project.id);
});

test("Desktop prompt router records ledger context and agent artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-desktop-prompt-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  const stateRoot = await mkdtemp(join(tmpdir(), "flow-desktop-state-"));
  const registry = new DesktopProjectRegistry({ statePath: join(stateRoot, "projects.json") });
  const project = await registry.addProject(root);
  const router = new DesktopPromptRouter({
    projects: registry,
    agent: {
      async sendPrompt(input) {
        assert.equal(input.project.id, project.id);
        assert.equal(input.issueRef, "ISSUE-50");
        assert.match(input.threadId, /^thread-/);
        return {
          session: {
            id: "session-50",
            provider: "pi",
            workspacePath: root,
            status: "active",
          },
          artifacts: [{
            id: "artifact-50",
            artifactType: "diff",
            title: "Prompt router diff",
            uri: "artifact://artifact-50",
          }],
          summary: "Prompt routed",
        };
      },
    },
  });

  const result = await router.submit({
    prompt: "Route this to the active project.",
    issueRef: "ISSUE-50",
  });
  const ledger = createWorkflowLedger({ cwd: root });
  assert.ok(ledger.readContext);
  const projection = await ledger.readContext({ projectId: project.id });

  assert.equal(result.project.id, project.id);
  assert.equal(result.sessionId, "session-50");
  assert.deepEqual(result.artifactRefs, ["artifact-50"]);
  assert.equal(projection.active.projectId, project.id);
  assert.equal(projection.active.issueRef, "ISSUE-50");
  assert.equal(projection.active.sessionId, "session-50");
  assert.equal(projection.active.artifactId, "artifact-50");
  assert.equal(projection.prompts[0].target, "artifact");
  assert.equal(projection.sessions[0].provider, "pi");
  assert.equal(projection.artifacts[0].title, "Prompt router diff");
});

test("Desktop prompt router preserves prompt context when agent routing fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-desktop-prompt-error-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  const stateRoot = await mkdtemp(join(tmpdir(), "flow-desktop-state-error-"));
  const registry = new DesktopProjectRegistry({ statePath: join(stateRoot, "projects.json") });
  const project = await registry.addProject(root);
  const router = new DesktopPromptRouter({
    projects: registry,
    agent: {
      async sendPrompt() {
        throw new Error("Pi SDK is not installed.");
      },
    },
  });

  const result = await router.submit({
    prompt: "Route this even if pi is missing.",
    issueRef: "ISSUE-51",
  });
  const ledger = createWorkflowLedger({ cwd: root });
  assert.ok(ledger.readContext);
  const projection = await ledger.readContext({ projectId: project.id });

  assert.match(result.error ?? "", /Pi SDK is not installed/);
  assert.equal(projection.prompts.length, 1);
  assert.equal(projection.prompts[0].prompt, "Route this even if pi is missing.");
  assert.match(projection.prompts[0].summary ?? "", /Pi SDK is not installed/);
  assert.equal(projection.active.issueRef, "ISSUE-51");
});

test("Desktop action router records evidence, result, docs, and doctor output", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-desktop-actions-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  const stateRoot = await mkdtemp(join(tmpdir(), "flow-desktop-action-state-"));
  const registry = new DesktopProjectRegistry({ statePath: join(stateRoot, "projects.json") });
  const project = await registry.addProject(root);
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root: join(root, ".flow", "runtime") }), ledger });
  await ledger.writeIssue({
    ref: "ISSUE-54",
    title: "Record workflow outcomes from desktop",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  const router = new DesktopActionRouter({
    projects: registry,
    runtimeForProject: () => runtime,
    ledgerForProject: () => ledger,
  });
  const evidence = await router.invoke({
    action: "record_evidence",
    issueRef: "ISSUE-54",
    payload: { summary: "Tests passed.", source: "npm test" },
  });
  await router.invoke({
    action: "record_result",
    issueRef: "ISSUE-54",
    payload: { summary: "Implementation done.", status: "succeeded", testsRun: ["npm test"] },
  });
  await router.invoke({
    action: "record_documentation",
    issueRef: "ISSUE-54",
    payload: { summary: "No docs needed.", disposition: "not_needed" },
  });
  const doctor = await router.invoke({ action: "run_doctor", issueRef: "ISSUE-54" });

  const issue = await ledger.readIssue("ISSUE-54");
  const results = await ledger.listWorkerResults("ISSUE-54");
  const projection = await ledger.readContext({ projectId: project.id });

  assert.equal(evidence.summary, "Evidence recorded for ISSUE-54.");
  assert.equal(issue?.metadata.evidenceRecorded, true);
  assert.equal(issue?.metadata.documentationRecorded, true);
  assert.equal(results.length, 1);
  assert.equal(results[0].summary, "Implementation done.");
  assert.match(doctor.summary, /Doctor/);
  assert.equal(projection.artifacts.length, 4);
});

test("Desktop action router runs Autoflow as the primary issue action", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-desktop-autoflow-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  const stateRoot = await mkdtemp(join(tmpdir(), "flow-desktop-autoflow-state-"));
  const registry = new DesktopProjectRegistry({ statePath: join(stateRoot, "projects.json") });
  const project = await registry.addProject(root);
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root: join(root, ".flow", "runtime") }), ledger });
  await ledger.writeIssue({
    ref: "ISSUE-55",
    title: "Autoflow from desktop",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });

  const router = new DesktopActionRouter({
    projects: registry,
    runtimeForProject: () => runtime,
    ledgerForProject: () => ledger,
  });
  const result = await router.invoke({ action: "autoflow", issueRef: "ISSUE-55" });

  const issue = await ledger.readIssue("ISSUE-55");
  const projection = await ledger.readContext({ projectId: project.id });

  assert.match(result.summary, /Autoflow needs_confirmation for ISSUE-55/);
  assert.equal(issue?.metadata["workflow.autoflow.attempts"], 1);
  assert.equal(projection.artifacts.length, 1);
  assert.equal(projection.artifacts[0].title, "Autoflow output");
  assert.equal(projection.artifacts[0].metadata.action, "autoflow");
});

test("Pi session driver starts issue-linked sessions and records FlowSessionLink", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-session-start-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-34",
    title: "Wire issue click to pi coding agent session",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-gh-34",
    },
  });

  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop",
    agent: false,
  });

  const session = await driver.startSession("gh-34");
  assert.equal(session.issueRef, "GH-34");
  assert.equal(session.flowSessionId, "desktop");
  assert.equal(session.timeline.length, 1);
  assert.match(session.timeline[0].content, /Agent session started/);

  const linksRaw = await readFile(join(root, ".flow", "runtime", "pi-session-links.json"), "utf8");
  const linksPayload = JSON.parse(linksRaw) as { links: Array<{ issueRef: string; flowSessionId: string; piSessionId: string }> };
  assert.equal(linksPayload.links[0].issueRef, "GH-34");
  assert.equal(linksPayload.links[0].flowSessionId, "desktop");
  assert.equal(linksPayload.links[0].piSessionId, session.id);
});

test("Pi session driver appends user prompt and assistant response", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-session-prompt-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-35",
    title: "Add composer to send prompts to pi sessions",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop",
    agent: false,
  });

  const started = await driver.startSession("GH-35");
  const updated = await driver.postPrompt(started.id, "Please draft implementation steps.");
  const userMessage = updated.timeline.find((item) => item.role === "user");
  const assistantMessage = updated.timeline.find((item) => item.role === "assistant");

  assert.equal(userMessage?.content, "Please draft implementation steps.");
  assert.match(assistantMessage?.content ?? "", /Queued prompt for GH-35/);
  assert.equal(updated.timeline.length >= 3, true);
});

test("Pi session driver queues follow-up prompts while a run is active", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-session-queue-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-168",
    title: "Queue follow-up prompts",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const prompts: string[] = [];
  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop",
    agent: {
      async prompt(input) {
        prompts.push(input.prompt);
        if (prompts.length === 1) await firstGate;
        return {
          sessionId: input.sessionId,
          status: "active",
          summary: `Handled ${prompts.length}.`,
        };
      },
    },
  });

  const started = await driver.startSession("GH-168");
  const first = await driver.sendUserMessage(started.id, { text: "First prompt" });
  const second = await driver.sendUserMessage(started.id, { text: "Second prompt" });

  assert.equal(first.status, "running");
  assert.equal(second.timeline.filter((item) => item.role === "user").length, 2);
  assert.equal(prompts.length, 1);
  releaseFirst?.();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /First prompt/);
  assert.match(prompts[1], /Second prompt/);
});

test("Pi session driver persists issue-linked session state for reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-session-reopen-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-38",
    title: "Persist desktop pi session state",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  const first = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop",
    agent: false,
  });
  const started = await first.startSession("GH-38");
  await first.postPrompt(started.id, "Remember this turn.");

  const second = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop",
    agent: false,
  });
  const reopened = await second.getSession(started.id);

  assert.equal(reopened.issueRef, "GH-38");
  assert.equal(reopened.timeline.some((item) => item.role === "user" && item.content === "Remember this turn."), true);
});

test("Pi session driver records clear failure when pi runtime fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-session-error-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-36",
    title: "Report missing pi runtime",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });
  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop",
    agent: {
      async prompt() {
        throw new Error("No pi auth configured.");
      },
    },
  });

  const started = await driver.startSession("GH-36");
  const updated = await driver.postPrompt(started.id, "Run the real agent.");
  const assistantMessage = updated.timeline.find((item) => item.role === "assistant");
  const linksRaw = await readFile(join(root, ".flow", "runtime", "pi-session-links.json"), "utf8");
  const linksPayload = JSON.parse(linksRaw) as { links: Array<{ issueRef: string; status?: string }> };

  assert.equal(updated.status, "failed");
  assert.match(updated.error ?? "", /No pi auth configured/);
  assert.match(assistantMessage?.content ?? "", /Pi session failed: No pi auth configured/);
  assert.equal(linksPayload.links[0].status, "failed");
});

test("Pi agent orchestrator starts the next ready issue and records a result", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-orchestrator-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-56",
    title: "Run through orchestrator",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      "workflow.repos.app_api.worktree_path": root,
    },
  });
  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop-project",
    agent: {
      async prompt() {
        return {
          sessionId: "pi-gh-56",
          workspacePath: root,
          status: "active",
          summary: "Implemented by Pi.",
          timeline: [{
            id: "assistant-1",
            role: "assistant",
            content: "Implemented by Pi.",
            createdAt: nowIso(),
          }],
        };
      },
    },
  });
  const dashboardState = {
    async payload() {
      return {
        ok: true,
        issues: [{ ref: "GH-56", workStatus: "Ready", title: "Run through orchestrator" }],
      };
    },
  };
  const orchestrator = new PiAgentOrchestrator({
    projectId: "project",
    runtime,
    dashboardState: dashboardState as never,
    piSessionDriver: driver,
  });

  const status = await orchestrator.tick();
  assert.equal(status.phase, "starting");
  for (let index = 0; index < 20; index += 1) {
    if ((await ledger.listWorkerResults("GH-56")).length) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const results = await ledger.listWorkerResults("GH-56");
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "succeeded");
  assert.match(results[0].summary, /Implemented by Pi/);
});

test("Pi agent orchestrator sends follow-up messages to running sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-orchestrator-followup-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-57",
    title: "Follow up while running",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });
  const modes: Array<string | undefined> = [];
  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop-project",
    agent: {
      async prompt(input) {
        modes.push(input.mode);
        return {
          sessionId: input.sessionId,
          status: "active",
          summary: "ok",
          timeline: [],
        };
      },
    },
  });
  const started = await driver.startSession("GH-57");
  started.status = "running";
  const orchestrator = new PiAgentOrchestrator({
    projectId: "project",
    runtime,
    dashboardState: { async payload() { return { ok: true, issues: [] }; } } as never,
    piSessionDriver: driver,
  });

  await orchestrator.sendUserMessage({ issueRef: "GH-57", sessionId: started.id, text: "More detail." });
  assert.deepEqual(modes, ["followUp"]);
});

test("Pi agent orchestrator doctors stale external issues instead of starting Pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-orchestrator-stale-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-58",
    title: "Missing external issue",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });
  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop-project",
    agent: {
      async prompt() {
        throw new Error("Pi should not start for stale issues.");
      },
    },
  });
  const doctorRuntime = Object.create(runtime) as typeof runtime;
  doctorRuntime.diagnoseIssue = async () => {
    throw new Error("GraphQL: Could not resolve to an issue or pull request with the number of 58. (repository.issue)");
  };
  const orchestrator = new PiAgentOrchestrator({
    projectId: "project",
    runtime: doctorRuntime,
    dashboardState: {
      async payload() {
        return {
          ok: true,
          issues: [{ ref: "GH-58", workStatus: "Ready", title: "Missing external issue" }],
        };
      },
    } as never,
    piSessionDriver: driver,
  });

  await orchestrator.tick();
  for (let index = 0; index < 20; index += 1) {
    if (orchestrator.getStatus().phase === "needs_input") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const status = orchestrator.getStatus();
  assert.equal(status.phase, "needs_input");
  assert.match(status.summary ?? "", /External issue GH-58 is missing or stale/);
  assert.equal((await ledger.listWorkerResults("GH-58")).length, 0);
});

test("Pi SDK session runner maps real SDK events into desktop timeline", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-sdk-runner-"));
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  const driverEvents: string[] = [];
  const runner = new PiSdkSessionRunner({
    loadModule: async () => ({
      SessionManager: {
        create: () => ({ mode: "create" }),
        open: () => ({ mode: "open" }),
      },
      createAgentSession: async () => ({
        session: {
          sessionId: "real-pi-session",
          sessionFile: join(root, "session.jsonl"),
          subscribe(next) {
            listener = next;
            return () => {
              listener = undefined;
            };
          },
          async prompt() {
            listener?.({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
            listener?.({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: "ok", isError: false });
            listener?.({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "Done from pi." },
            });
          },
          dispose() {},
        },
      }),
    }),
  });

  const result = await runner.prompt({
    sessionId: "seed",
    issueRef: "GH-37",
    prompt: "Use pi.",
    repoRoot: root,
    onEvent(event) {
      driverEvents.push(event.type);
      if (event.type === "assistantDelta") {
        assert.equal(event.text, "Done from pi.");
      }
    },
  });

  assert.equal(result.sessionId, "real-pi-session");
  assert.equal(result.sessionFile, join(root, "session.jsonl"));
  assert.match(result.summary ?? "", /Done from pi/);
  assert.equal(result.timeline?.some((item) => item.role === "tool" && item.toolName === "read"), true);
  assert.deepEqual(driverEvents, ["toolStarted", "toolFinished", "assistantDelta"]);
});

test("Local issue tracker creates issues through the Flow ledger surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-local-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = new FlowWorkRuntime({
    store: new FlowStore({ root: join(root, ".flow/runtime") }),
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, projectName: "Flow" }),
    collaboration: new NoopCodeCollaborationAdapter(),
    projectRoot: root,
    readiness: { assess: assessIssue },
  });

  await runtime.createSession("local-session");
  const issue = await runtime.createIssue("local-session", {
    issueType: "Task",
    summary: "Spike local surface",
    description: "Keep Flow usable without GitHub.",
  });

  assert.equal(issue.ref, "FLOW-1");
  assert.equal(issue.title, "Spike local surface");
  assert.equal((await ledger.readIssue("FLOW-1"))?.ref, "FLOW-1");
  assert.deepEqual(await new NoopCodeCollaborationAdapter().findCodeReviews("flow"), []);
});

test("Flow config builds default and custom work type registries", () => {
  const baseConfig = flowConfigSchema.parse({
    version: "1",
    project: { name: "Example" },
    topology: { repos: { main: { name: "example" } } },
  });
  const defaultRegistry = configToWorkTypeRegistry(baseConfig);
  assert.equal(defaultRegistry.workTypeForCategory("implement"), "flow.implement");
  assert.equal(defaultRegistry.executorCanRun("live_agent_thread", "flow.implement", ["code.edit"]), true);

  const customRegistry = configToWorkTypeRegistry(flowConfigSchema.parse({
    ...baseConfig,
    workTypes: [{
      name: "project.fix",
      category: "implement",
      requiredCapabilities: ["code.edit"],
      allowedExecutors: ["live_agent_thread"],
      outputType: "worker_result",
    }],
    executors: [{
      name: "live_agent_thread",
      capabilities: ["code.edit"],
      outputs: ["worker_result"],
    }],
  }));
  assert.equal(customRegistry.workTypeForCategory("implement"), "project.fix");
  assert.equal(customRegistry.executorCanRun("live_agent_thread", "project.fix", ["code.edit"]), true);
});

test("Local thread executor advertises capabilities and returns a reportable handoff result", async () => {
  const executor = new LocalThreadExecutor();
  assert.equal(executor.executionMode, "local_thread");
  assert.equal(executor.canRun("flow.implement", ["code.edit", "test.run"]), true);
  assert.equal(executor.canRun("flow.implement", ["deploy.prod"]), false);
  const progress: string[] = [];
  const result = await executor.run({
    id: "local-1",
    issueRef: "ISSUE-601",
    repoKey: "app_api",
    executor: "live_agent_thread",
    prompt: "Implement the change.",
    createdAt: nowIso(),
  }, (event) => {
    progress.push(event.summary);
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.executor, "live_agent_thread");
  assert.match(result.nextPickup ?? "", /Implement the change/);
  assert.deepEqual(progress, ["Local thread executor prepared a handoff request."]);
});

test("Work envelopes parse YAML frontmatter and preserve Markdown body", () => {
  const envelope = parseWorkEnvelope(`---
workType: flow.remediate
issueRef: ISSUE-123
repoKey: public_api
executionMode: local_thread
idempotencyKey: ISSUE-123:review
metadata:
  prNumber: 2914
---

Address only the unresolved review blockers.

- Run the smallest relevant verification.
- Return evidence.
`);

  assert.equal(envelope.workType, "flow.remediate");
  assert.equal(envelope.issueRef, "ISSUE-123");
  assert.equal(envelope.executionMode, "local_thread");
  assert.equal(envelope.metadata.prNumber, 2914);
  assert.match(envelope.body, /Address only the unresolved review blockers/);
});

test("Work Runtime submits work envelopes idempotently", async () => {
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root: await mkdtemp(join(tmpdir(), "flow-envelope-")) }), ledger });
  const session = await workRuntime.createSession("session-envelope-idempotency");
  await ledger.writeIssue({
    ref: "ISSUE-124",
    title: "Envelope idempotency",
    repoKeys: ["public_api"],
    state: "ready_to_run",
    metadata: {},
  });

  const envelope = `---
workType: flow.implement
issueRef: ISSUE-124
repoKey: public_api
executionMode: background
idempotencyKey: ISSUE-124:implementation
---

Implement the bounded change.
`;

  const first = await workRuntime.submitWorkEnvelope(session.id, envelope);
  const second = await workRuntime.submitWorkEnvelope(session.id, envelope);
  const jobs = await ledger.listWorkJobs("ISSUE-124");

  assert.equal(first.id, second.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].input.executionMode, "background");
  assert.equal(jobs[0].input.idempotencyKey, "ISSUE-124:implementation");
});

test("Readiness blocks failed worker results", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-1",
      title: "Test issue",
      repoKeys: ["app_api"],
      state: "running",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-1",
        issueRef: "ISSUE-1",
        repoKey: "app_api",
        status: "failed",
        summary: "Tests failed",
        changedFiles: [],
        testsRun: ["pytest"],
        blockers: ["pytest failed"],
        completedAt: nowIso(),
      },
    ],
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.findings.some((finding) => finding.severity === "blocker"), true);
});

test("Readiness blocks successful Worker output until handoff records exist", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-11",
      title: "Needs handoff",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-11",
        issueRef: "ISSUE-11",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Changed code",
        changedFiles: ["worker/src/example.py"],
        testsRun: ["pytest"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(
    assessment.findings.map((finding) => finding.summary).join(","),
    "Acceptance evidence is missing.,Documentation disposition is missing.,Pull request is missing.",
  );
});

test("Readiness supports local no-PR workflows when code review is disabled", () => {
  const assessment = assessIssue({
    issue: {
      ref: "LOCAL-11",
      title: "Needs local closeout",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-local-11",
        issueRef: "LOCAL-11",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Changed code",
        changedFiles: ["worker/src/example.py"],
        testsRun: ["pytest"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    evidenceRecorded: true,
    documentationRecorded: true,
    codeReviewRequired: false,
  });

  assert.equal(assessment.readyToAdvance, true);
  assert.equal(assessment.reviewReady, true);
  assert.equal(assessment.findings.some((finding) => finding.summary === "Pull request is missing."), false);
});

test("Readiness treats retryable handoff timeout after success as warning", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-12",
      title: "Retryable timeout after success",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-success",
        issueRef: "ISSUE-12",
        repoKey: "app_api",
        executor: "live_agent_thread",
        status: "succeeded",
        summary: "Existing agent-thread evidence is valid",
        changedFiles: [],
        testsRun: ["pixi run pytest shared/provider/tests/test_panorama_one_click_contract.py"],
        blockers: [],
        completedAt: nowIso(),
      },
      {
        taskId: "worker-timeout",
        issueRef: "ISSUE-12",
        repoKey: "app_api",
        status: "blocked",
        summary: "Agent handoff timed out or was interrupted before returning a structured result.",
        changedFiles: [],
        testsRun: [],
        blockers: ["Agent handoff timed out or was interrupted before returning a structured result."],
        completedAt: nowIso(),
      },
    ],
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/12",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      checksPassing: true,
      autoReviewStatus: "passed",
      humanReviewRequired: true,
      reviewDecision: "REVIEW_REQUIRED",
      reviewCommentCount: 2,
      reviewCommentAuthors: ["khwiri", "developer-hla"],
    },
    evidenceRecorded: true,
    documentationRecorded: true,
  });

  assert.equal(assessment.readyToAdvance, true);
  assert.equal(assessment.reviewReady, true);
  assert.equal(assessment.findings.some((finding) => finding.severity === "blocker"), false);
  assert.equal(assessment.findings.some((finding) => finding.summary.includes("timed out")), true);
  const approvalFinding = assessment.findings.find((finding) => finding.summary === "Approval review is required.");
  assert.match(approvalFinding?.detail ?? "", /Comment-only reviews do not satisfy approval-required review policy/);
  const commentFinding = assessment.findings.find((finding) => finding.summary === "Review comments are present.");
  assert.match(commentFinding?.detail ?? "", /khwiri, developer-hla/);
});

test("Readiness ignores obsolete undraft executor blockers once PR is ready", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-15272",
      title: "Coverage PR",
      repoKeys: ["app_api"],
      state: "blocked",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-issue-15272-implementation",
        issueRef: "ISSUE-15272",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Implemented coverage changes.",
        changedFiles: ["scripts/check_coverage.py"],
        testsRun: ["pixi run coverage-check"],
        blockers: [],
        completedAt: nowIso(),
      },
      {
        taskId: "worker-issue-15272-undraft-pr1406",
        issueRef: "ISSUE-15272",
        repoKey: "app_api",
        status: "blocked",
        summary: "Agent handoff could not find provider credentials.",
        changedFiles: [],
        testsRun: [],
        blockers: ["Agent handoff could not find provider credentials."],
        nextPickup: "Configure credentials, then undraft PR #1406.",
        handoffPrompt: "Convert PR https://github.com/ExampleOrg/app-api/pull/1406 from draft to ready for review.",
        completedAt: nowIso(),
      },
    ],
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1344",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      checksPassing: true,
      autoReviewStatus: "passed",
    },
    evidenceRecorded: true,
    documentationRecorded: true,
  });

  assert.equal(assessment.readyToAdvance, true);
  assert.equal(assessment.findings.some((finding) => finding.summary.includes("provider credentials")), false);
  assert.equal(assessment.findings.some((finding) => finding.summary.includes("Pull request is still draft")), false);
});

test("Readiness ignores obsolete missing-workspace blockers once a worktree exists", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-15389",
      title: "Evaluate Celery locking",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {
        "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-15389",
      },
    },
    workerResults: [
      {
        taskId: "worker-retry-1",
        issueRef: "ISSUE-15389",
        repoKey: "app_api",
        status: "blocked",
        summary: "Handoff workspace path is missing for app_api.",
        changedFiles: [],
        testsRun: [],
        blockers: ["Handoff workspace path is missing."],
        nextPickup: "Run prepare workspace for the routed repo, then retry advance/autoflow.",
        completedAt: nowIso(),
      },
    ],
  });

  assert.equal(assessment.readyToAdvance, true);
  assert.equal(assessment.reviewReady, false);
  assert.equal(assessment.findings.some((finding) => finding.severity === "blocker"), false);
  assert.equal(assessment.findings.some((finding) => finding.summary.includes("workspace path is missing")), false);
});

test("Readiness treats provider-credential executor failures as retryable", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-15738",
      title: "Review remediation",
      repoKeys: ["app_api"],
      state: "blocked",
      metadata: {
        "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-15738",
      },
    },
    workerResults: [
      {
        taskId: "worker-issue-15738-implementation",
        issueRef: "ISSUE-15738",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Implemented GeoParquet compatibility fix.",
        changedFiles: ["worker/src/services/controller_data/etl/provider_parquet.py"],
        testsRun: ["pixi run pytest worker/tests/services/controller_data/etl/test_provider_parquet.py"],
        blockers: [],
        completedAt: nowIso(),
      },
      {
        taskId: "worker-issue-15738-remediate",
        issueRef: "ISSUE-15738",
        repoKey: "app_api",
        status: "blocked",
        summary: "Agent handoff could not find provider credentials.",
        changedFiles: [],
        testsRun: [],
        blockers: ["Agent handoff could not find provider credentials."],
        nextPickup: "Configure provider credentials, then retry the handoff.",
        completedAt: nowIso(),
      },
    ],
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1411",
      isDraft: false,
      checksPassing: false,
      autoReviewStatus: "failed",
    },
  });

  assert.equal(assessment.findings.some((finding) => finding.summary.includes("provider credentials")), false);
  assert.equal(assessment.findings.some((finding) => finding.summary === "Pull request checks are not passing."), true);
  assert.equal(assessment.findings.some((finding) => finding.summary === "Auto review checks failed."), true);
});

test("Readiness blocks duplicate review remediation when executor changes are unpushed", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-15738",
      title: "Review remediation",
      repoKeys: ["app_api"],
      state: "awaiting_human",
      metadata: {
        "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-15738",
        "workflow.repos.app_api.dirty": true,
      },
    },
    workerResults: [
      {
        taskId: "worker-issue-15738-remediate",
        issueRef: "ISSUE-15738",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Fixed import ordering.",
        changedFiles: ["worker/src/services/controller_data/etl/provider_parquet.py"],
        testsRun: ["pre-commit run --files worker/src/services/controller_data/etl/provider_parquet.py"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1411",
      isDraft: false,
      checksPassing: false,
      autoReviewStatus: "failed",
    },
  });

  assert.equal(assessment.findings.some((finding) => finding.summary === "Executor changes are not pushed."), true);
  assert.equal(assessment.readyToAdvance, false);
});

test("Readiness ignores stale review blockers once the pull request is merged", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-1393",
      title: "Merged PR",
      repoKeys: ["app_api"],
      state: "blocked",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-1393",
        issueRef: "ISSUE-1393",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Implemented fix",
        changedFiles: [],
        testsRun: [],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1393",
      state: "MERGED",
      mergedAt: "2026-05-11T19:11:01Z",
      isDraft: false,
      checksPassing: false,
      autoReviewStatus: "failed",
      humanReviewRequired: true,
    },
    evidenceRecorded: true,
    documentationRecorded: true,
  });

  assert.equal(assessment.reviewReady, true);
  assert.equal(assessment.findings.some((finding) => finding.severity === "blocker"), false);
});

test("Readiness reports external provider escalation as a blocker", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-15",
      title: "Provider needs samples",
      repoKeys: ["app_api"],
      state: "blocked",
      metadata: {
        externalProviderEscalation: {
          provider: "Provider",
          summary: "Provider may need to investigate the sample files.",
          blocker: "Need affected Provider file IDs or batch IDs.",
          recordedAt: nowIso(),
        },
      },
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.reviewReady, false);
  assert.equal(
    assessment.findings.some((finding) => finding.summary === "Blocked on Provider escalation."),
    true,
  );
  const escalationFinding = assessment.findings.find((finding) => finding.summary === "Blocked on Provider escalation.");
  assert.equal(escalationFinding?.detail, "Need affected Provider file IDs or batch IDs.");
});

test("Readiness blocks draft pull requests", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-13",
      title: "Draft PR",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-13",
        issueRef: "ISSUE-13",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Changed code",
        changedFiles: ["worker/src/example.py"],
        testsRun: ["pytest"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    evidenceRecorded: true,
    documentationRecorded: true,
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1",
      isDraft: true,
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.findings[0].summary, "Pull request is still draft.");
});

test("Readiness blocks pull requests missing the repo template", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-22",
      title: "Missing PR template",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-22",
        issueRef: "ISSUE-22",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Changed code",
        changedFiles: ["worker/src/example.py"],
        testsRun: ["pytest"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    evidenceRecorded: true,
    documentationRecorded: true,
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1402",
      isDraft: false,
      checksPassing: true,
      autoReviewStatus: "passed",
      templateMissingHeadings: [
        "Issue or Reason for Change",
        "Description",
        "Summary of Changes",
        "Related PRs or Issues",
      ],
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.reviewReady, false);
  assert.equal(assessment.findings[0].summary, "Pull request does not follow the repo template.");
  assert.match(assessment.findings[0].detail ?? "", /Issue or Reason for Change/);
});

test("Readiness blocks conflicted pull requests", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-16",
      title: "Conflicted PR",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-16",
        issueRef: "ISSUE-16",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Changed code",
        changedFiles: ["worker/src/example.py"],
        testsRun: ["pytest"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    evidenceRecorded: true,
    documentationRecorded: true,
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1",
      isDraft: false,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      checksPassing: true,
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.reviewReady, false);
  assert.equal(assessment.findings[0].summary, "Pull request has merge conflicts.");
});

test("Readiness blocks auto-review must-fix feedback", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-21",
      title: "Must fix PR",
      repoKeys: ["public_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-21",
        issueRef: "ISSUE-21",
        repoKey: "public_api",
        status: "succeeded",
        summary: "Changed code",
        changedFiles: ["packages/example.ts"],
        testsRun: ["pnpm test"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    evidenceRecorded: true,
    documentationRecorded: true,
    review: {
      prUrl: "https://github.com/ExampleOrg/public-api/pull/2971",
      isDraft: false,
      checksPassing: true,
      autoReviewStatus: "passed",
      autoReviewMustFix: true,
      autoReviewMustFixDetail: "New test files use // @ts-nocheck.",
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.reviewReady, false);
  assert.equal(assessment.findings[0].summary, "Auto review has must-fix feedback.");
  assert.equal(assessment.findings[0].detail, "New test files use // @ts-nocheck.");
});

test("Readiness ignores empty auto-review must-fix text from stale metadata", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-22",
      title: "Empty must-fix metadata",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-22",
        issueRef: "ISSUE-22",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Changed code",
        changedFiles: ["worker/src/example.py"],
        testsRun: ["pytest"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    evidenceRecorded: true,
    documentationRecorded: true,
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1405",
      isDraft: false,
      checksPassing: true,
      autoReviewStatus: "passed",
      autoReviewMustFix: true,
      autoReviewMustFixDetail: "None found.",
    },
  });

  assert.equal(assessment.reviewReady, true);
  assert.equal(assessment.findings.some((finding) => finding.summary === "Auto review has must-fix feedback."), false);
});

test("Readiness requires auto-review confirmations to be posted to the code review", () => {
  const base = {
    issue: {
      ref: "ISSUE-23",
      title: "Needs confirmation",
      repoKeys: ["app_api"],
      state: "ready_to_run" as const,
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-23",
        issueRef: "ISSUE-23",
        repoKey: "app_api",
        status: "succeeded" as const,
        summary: "Changed code",
        changedFiles: ["worker/src/example.py"],
        testsRun: ["pytest"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    evidenceRecorded: true,
    documentationRecorded: true,
  };

  const missingPost = assessIssue({
    ...base,
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1402",
      isDraft: false,
      checksPassing: true,
      autoReviewStatus: "passed",
      autoReviewNeedsConfirmation: true,
      autoReviewNeedsConfirmationDetail: "Confirm Provider semantics.",
      autoReviewNeedsConfirmationDisposition: "accept",
    },
  });

  assert.equal(missingPost.reviewReady, false);
  assert.equal(missingPost.findings[0].summary, "Auto review confirmation has not been posted to the code review.");

  const posted = assessIssue({
    ...base,
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1402",
      isDraft: false,
      checksPassing: true,
      autoReviewStatus: "passed",
      autoReviewNeedsConfirmation: true,
      autoReviewNeedsConfirmationDetail: "Confirm Provider semantics.",
      autoReviewNeedsConfirmationDisposition: "accept",
      autoReviewNeedsConfirmationPostedUrl: "https://github.com/ExampleOrg/app-api/pull/1402#issuecomment-1",
    },
  });

  assert.equal(posted.reviewReady, true);
  assert.equal(
    posted.findings.some((finding) => finding.summary === "Auto review requires confirmation."),
    false,
  );
});

test("Readiness blocks worker spawn when repo routing is missing", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-18",
      title: "Missing route",
      repoKeys: [],
      state: "queued",
      metadata: {},
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.findings[0].summary, "Repo routing is missing.");
});

test("Work Runtime advances by reconciling then requesting confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-test");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-2",
    title: "Build workRuntime",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });

  const result = await workRuntime.advanceIssue(session.id);

  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.session.pendingConfirmation?.action, "request_execution");
  assert.equal(result.issue?.ref, "ISSUE-2");
});

test("Work Runtime does not leak findings across selected issues", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-finding-scope");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-OLD",
    title: "Old issue",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });
  const blocked = await workRuntime.advanceIssue(session.id);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.message, /Repo routing is missing/);

  const selected = await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-NEW",
    title: "New issue",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });
  const summary = await workRuntime.summarizeHandoff(session.id);

  assert.equal(selected.findings.length, 0);
  assert.match(summary, /ISSUE-NEW: New issue/);
  assert.doesNotMatch(summary, /Repo routing is missing/);
  assert.doesNotMatch(summary, /ISSUE-OLD/);
});

test("Work Runtime does not request an unknown-repo Worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-missing-route");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-19",
    title: "Missing route",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  const result = await workRuntime.advanceIssue(session.id);

  assert.equal(result.status, "blocked");
  assert.equal(result.message, "Repo routing is missing.");
  assert.equal(result.session.pendingConfirmation, undefined);
});

test("Work Runtime records repo routing and blocks until workspace exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger, projectRoot: root });
  const session = await workRuntime.createSession("session-route");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-20",
    title: "Route issue",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  const routed = await workRuntime.routeIssue(session.id, "ISSUE-20", ["app-api", "app_api"]);
  const result = await workRuntime.advanceIssue(session.id);

  assert.deepEqual(routed.repoKeys, ["app_api"]);
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.session.pendingConfirmation?.action, "prepare_workspace");
  assert.equal(result.message, "Prepare workspace for ISSUE-20 in app_api.");
});

test("Work Runtime rejects non-component repo keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger, projectRoot: root });
  const session = await workRuntime.createSession("session-route-invalid");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-20",
    title: "Route issue",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  await assert.rejects(
    workRuntime.routeIssue(session.id, "ISSUE-20", ["HostProject"]),
    /No valid repo keys provided/,
  );
});

test("Work Runtime prepares workspace before handoff confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan) {
        assert.equal(plan.repoPath, "/repo/app-api");
        assert.equal(plan.baseRef, "develop");
        return {
          branch: plan.branch,
          headSha: "abc123",
          dirty: false,
          entries: [],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-prepare");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-21",
    title: "Prepare workspace",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const prepared = await workRuntime.prepareWorkspace(session.id, "ISSUE-21", { repoKey: "app_api" });
  const result = await workRuntime.advanceIssue(session.id);
  const confirmationId = result.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const approved = await workRuntime.advanceIssue(session.id, confirmationId);

  assert.equal(
    prepared.metadata["workflow.repos.app_api.worktree_path"],
    "/repo/app-api/.worktrees/feature-issue-21-prepare-workspace",
  );
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.session.pendingConfirmation?.payload.repoKey, "app_api");
  assert.equal(approved.handoffRequest?.workspacePath, "/repo/app-api/.worktrees/feature-issue-21-prepare-workspace");
  assert.match(approved.handoffRequest?.prompt ?? "", /Prepared workspace: \/repo\/app-api\/.worktrees/);
});

test("Work Runtime records actual existing worktree path returned by source control", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan) {
        return {
          branch: plan.branch,
          headSha: "existing-sha",
          dirty: false,
          entries: [],
          worktreePath: "/repo/app-api/.worktrees/existing-branch-worktree",
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-existing-worktree");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-210",
    title: "Existing workspace",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const prepared = await workRuntime.prepareWorkspace(session.id, "ISSUE-210", { repoKey: "app_api" });

  assert.equal(
    prepared.metadata["workflow.repos.app_api.worktree_path"],
    "/repo/app-api/.worktrees/existing-branch-worktree",
  );
  assert.equal(prepared.metadata.work_dir, "/repo/app-api/.worktrees/existing-branch-worktree");
});

test("Work Runtime adopts an existing worktree into issue metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    git: {
      async inspect(repoPath) {
        assert.equal(repoPath, "/repo/app-api/.worktrees/feature-issue-3026");
        return {
          branch: "feature/issue-3026",
          headSha: "adopted-sha",
          dirty: true,
          entries: [" M src/app.ts"],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-adopt-workspace");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-3026",
    title: "Adopt workspace",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const adopted = await workRuntime.adoptWorkspace(session.id, "ISSUE-3026", {
    repoKey: "app_api",
    worktreePath: "/repo/app-api/.worktrees/feature-issue-3026",
  });
  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(adopted.metadata["workflow.repos.app_api.worktree_path"], "/repo/app-api/.worktrees/feature-issue-3026");
  assert.equal(adopted.metadata["workflow.repos.app_api.branch"], "feature/issue-3026");
  assert.equal(adopted.metadata["workflow.repos.app_api.head_sha"], "adopted-sha");
  assert.equal(adopted.metadata["workflow.repos.app_api.dirty"], true);
  assert.notEqual(advanced.message, "Prepare workspace for ISSUE-3026 in app_api.");
});

test("Work Runtime adopts a branch as stealth-mode Flow work", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    git: {
      async inspect(repoPath) {
        assert.equal(repoPath, "/repo/public-api");
        return {
          branch: "work/spike-local-work",
          headSha: "branch-sha",
          dirty: false,
          entries: [],
          worktreePath: "/repo/public-api",
        };
      },
    },
    jira: {
      async viewIssue() {
        throw new Error("external issue tracker should not be read for branch adoption");
      },
    },
  });
  const session = await workRuntime.createSession("session-adopt-branch");

  const adopted = await workRuntime.adoptBranch(session.id, {
    repoKey: "public_api",
    worktreePath: "/repo/public-api",
    summary: "Spike local work",
  });
  const selected = await workRuntime.summarizeHandoff(session.id);

  assert.equal(adopted.ref, "FLOW-1");
  assert.equal(adopted.title, "Spike local work");
  assert.deepEqual(adopted.repoKeys, ["public_api"]);
  assert.equal(adopted.metadata["workflow.issue.origin"], "branch");
  assert.equal(adopted.metadata["workflow.external.issue.status"], "unpublished");
  assert.equal(adopted.metadata["workflow.external.code_review.status"], "unpublished");
  assert.equal(adopted.metadata["workflow.repos.public_api.branch"], "work/spike-local-work");
  assert.equal(adopted.metadata["workflow.repos.public_api.head_sha"], "branch-sha");
  assert.match(selected, /FLOW-1: Spike local work/);
});

test("Work Runtime inspects queue from workflow ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "ISSUE-5",
    title: "Queue item",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  const queue = await workRuntime.inspectQueue(1);

  assert.equal(queue.length, 1);
  assert.equal(queue[0].ref, "ISSUE-5");
});

test("Work Runtime accepts pure issue tracker providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    issueTracker: {
      capabilities: {
        canCreateIssues: false,
        canTransitionIssues: false,
        canPostComments: false,
        canManageActivePlanningLane: false,
      },
      async getIssue(ref) {
        return {
          ref,
          title: "Provider issue",
          status: "Ready for Dev",
          statusCategory: "new",
          type: "story",
          url: `https://tracker.example/${ref}`,
          labels: ["app-api"],
        };
      },
      async fetchActiveQueue(limit) {
        assert.equal(limit, 10);
        return [
          {
            ref: "ISSUE-900",
            title: "Provider queue issue",
            status: "Ready for Dev",
            statusCategory: "new",
            type: "story",
            url: "https://tracker.example/ISSUE-900",
            labels: ["app-api"],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);

  assert.equal(queue.length, 1);
  assert.equal(queue[0].ref, "ISSUE-900");
  assert.equal(queue[0].title, "Provider queue issue");
  assert.deepEqual(queue[0].repoKeys, ["app_api"]);
  assert.equal(queue[0].metadata.issueStatus, "Ready for Dev");
  assert.equal(queue[0].metadata.issueType, "story");
  assert.equal(queue[0].metadata.jiraStatus, undefined);
});

test("Work Runtime inspects a configured issue tracker issue without writing ledger state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    issueTracker: {
      capabilities: {
        canCreateIssues: false,
        canTransitionIssues: false,
        canPostComments: false,
        canManageActivePlanningLane: false,
      },
      async getIssue(ref) {
        return {
          ref,
          title: "Provider issue view",
          status: "Ready for Dev",
          statusCategory: "To Do",
          type: "story",
          url: `https://tracker.example/${ref}`,
          labels: ["app-api"],
        };
      },
    },
  });

  const issue = await workRuntime.inspectIssue("ISSUE-901");
  const stored = await ledger.readIssue("ISSUE-901");

  assert.equal(issue.ref, "ISSUE-901");
  assert.equal(issue.title, "Provider issue view");
  assert.deepEqual(issue.repoKeys, ["app_api"]);
  assert.equal(issue.metadata.issueStatus, "Ready for Dev");
  assert.equal(stored, undefined);
});

test("Work Runtime accepts pure source control providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let preparedInput: unknown;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    sourceControl: {
      async inspectWorkspace(repoPath) {
        return {
          branch: "develop",
          headSha: `inspect:${repoPath}`,
          dirty: false,
          entries: [],
        };
      },
      async prepareWorktree(input: { repoPath: string; worktreePath: string; branch: string; baseRef?: string }) {
        preparedInput = input;
        return {
          branch: input.branch,
          headSha: "provider-sha",
          dirty: false,
          entries: [" M src/provider.ts"],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-provider-source-control");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-901",
    title: "Provider workspace",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const prepared = await workRuntime.prepareWorkspace(session.id, "ISSUE-901", { repoKey: "app_api" });

  assert.deepEqual(preparedInput, {
    repoPath: "/repo/app-api",
    worktreePath: "/repo/app-api/.worktrees/feature-issue-901-provider-workspace",
    branch: "feature/issue-901-provider-workspace",
    baseRef: "develop",
  });
  assert.equal(prepared.metadata["workflow.repos.app_api.head_sha"], "provider-sha");
  assert.equal(prepared.metadata["workflow.repos.app_api.dirty"], false);
});

test("Work Runtime bootstraps an existing Jira issue into the workflow ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  const workRuntime = testWorkRuntime({
    store,
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue(key) {
        assert.equal(key, "ISSUE-15725");
        return {
          key,
          summary: "Provider Panorama app-key already-exists response causes start-auth 500",
          issueType: "Bug",
          status: "In Progress",
          statusCategory: "indeterminate",
          labels: ["app-api"],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-bootstrap-jira");

  const issue = await workRuntime.bootstrapJiraIssue(session.id, "ISSUE-15725", {
    repoKeys: ["app_api"],
    branch: "bug/ISSUE-15725-panorama-app-key-idempotent",
    worktreePath: "/repo/app-api/.worktrees/feature-issue-15607-validate-updated-provider-panorama-o",
  });
  const selectedSession = await store.readSession(session.id);
  const stored = await ledger.readIssue("ISSUE-15725");

  assert.equal(issue.ref, "ISSUE-15725");
  assert.equal(issue.state, "selected");
  assert.deepEqual(issue.repoKeys, ["app_api"]);
  assert.equal(selectedSession?.selectedIssueRef, "ISSUE-15725");
  assert.equal(stored?.metadata.jiraStatus, "In Progress");
  assert.equal(
    stored?.metadata["workflow.repos.app_api.branch"],
    "bug/ISSUE-15725-panorama-app-key-idempotent",
  );
  assert.equal(
    stored?.metadata["workflow.repos.app_api.worktree_path"],
    "/repo/app-api/.worktrees/feature-issue-15607-validate-updated-provider-panorama-o",
  );
});

test("Work Runtime creates Jira issues through Flow without generated labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  let createdInput: unknown;
  const workRuntime = testWorkRuntime({
    store,
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue(key) {
        assert.equal(key, "ISSUE-15738");
        return {
          key,
          summary: "GeoParquet Provider ETL fails on GeoArrow WKB parquet schema",
          issueType: "Bug",
          status: "Ready for Dev",
          statusCategory: "new",
          labels: [],
        };
      },
      async createIssue(input) {
        createdInput = input;
        return {
          key: "ISSUE-15738",
          summary: input.summary,
          issueType: input.issueType,
          status: "Ready for Dev",
          labels: [],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-create-jira");

  const issue = await workRuntime.createJiraIssue(session.id, {
    issueType: "Bug",
    summary: "GeoParquet Provider ETL fails on GeoArrow WKB parquet schema",
    description: "Follow-up from ISSUE-15461.",
    repoKeys: ["app_api"],
  });
  const selectedSession = await store.readSession(session.id);

  assert.deepEqual(createdInput, {
    projectKey: "ISSUE",
    issueType: "Bug",
    summary: "GeoParquet Provider ETL fails on GeoArrow WKB parquet schema",
    description: "Follow-up from ISSUE-15461.",
  });
  assert.equal(issue.ref, "ISSUE-15738");
  assert.equal(issue.metadata.jiraIssueType, "Bug");
  assert.deepEqual(issue.metadata.jiraLabels, []);
  assert.deepEqual(issue.repoKeys, ["app_api"]);
  assert.equal(selectedSession?.selectedIssueRef, "ISSUE-15738");
});

test("Work Runtime creates provider-neutral issues without requiring a Jira project key", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  let createdInput: unknown;
  const workRuntime = new FlowWorkRuntime({
    store,
    ledger,
    topology: legacyHostTopology,
    issueTracker: {
      capabilities: {
        canCreateIssues: true,
        canTransitionIssues: false,
        canPostComments: false,
        canManageActivePlanningLane: false,
      },
      async getIssue(ref) {
        return {
          ref,
          title: "Harden Flow issue creation",
          type: "task",
          status: "Open",
          statusCategory: "To Do",
          url: `https://github.com/example/flow/issues/${ref.replace("GH-", "")}`,
          labels: [],
        };
      },
      async createIssue(input) {
        createdInput = input;
        return {
          ref: "GH-15738",
          title: input.summary,
          description: input.description,
          type: input.issueType.toLowerCase(),
          status: "Open",
          statusCategory: "To Do",
          url: "https://github.com/example/flow/issues/15738",
          labels: [],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-create-provider-neutral");

  const issue = await workRuntime.createIssue(session.id, {
    issueType: "Task",
    summary: "Harden Flow issue creation",
    description: "Provider-neutral issue creation should not require Jira config.",
    repoKeys: ["main"],
  });

  assert.deepEqual(createdInput, {
    projectKey: undefined,
    issueType: "Task",
    summary: "Harden Flow issue creation",
    description: "Provider-neutral issue creation should not require Jira config.",
  });
  assert.equal(issue.ref, "GH-15738");
  assert.equal(issue.metadata.issueType, "task");
  assert.equal(issue.metadata.jiraIssueType, undefined);
  assert.deepEqual(issue.repoKeys, ["main"]);
});

test("Work Runtime keeps local provider issue metadata provider-neutral", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  const workRuntime = new FlowWorkRuntime({
    store,
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, prefix: "FLOW" }),
  });
  const session = await workRuntime.createSession("session-create-local");

  const issue = await workRuntime.createIssue(session.id, {
    issueType: "Task",
    summary: "Local provider metadata",
  });

  assert.equal(issue.ref, "FLOW-1");
  assert.equal(issue.metadata.issueStatus, "To Do");
  assert.equal(issue.metadata.issueType, "Task");
  assert.equal(issue.metadata.issueUrl, "flow://local/issues/FLOW-1");
  assert.equal(issue.metadata["workflow.external.issue.status"], "unpublished");
  assert.equal(issue.metadata["workflow.external.code_review.status"], "unpublished");
  assert.equal(issue.metadata.jiraStatus, undefined);
  assert.equal(issue.metadata.jiraIssueType, undefined);
  assert.equal(issue.metadata.jiraUrl, undefined);

  await ledger.writeIssue({
    ref: "FLOW-2",
    title: "Legacy local metadata",
    repoKeys: [],
    state: "queued",
    metadata: {
      jiraStatus: "To Do",
      jiraIssueType: "Task",
      jiraUrl: "flow://local/issues/FLOW-2",
    },
  });

  const legacyIssue = (await workRuntime.inspectQueue(10)).find((candidate) => candidate.ref === "FLOW-2");
  assert.equal(legacyIssue?.metadata.issueStatus, "To Do");
  assert.equal(legacyIssue?.metadata.issueType, "Task");
  assert.equal(legacyIssue?.metadata.issueUrl, "flow://local/issues/FLOW-2");
  assert.equal(legacyIssue?.metadata["workflow.external.issue.status"], "unpublished");
  assert.equal(legacyIssue?.metadata.jiraStatus, undefined);
  assert.equal(legacyIssue?.metadata.jiraIssueType, undefined);
  assert.equal(legacyIssue?.metadata.jiraUrl, undefined);
});

test("Work Runtime moves issues into the active Jira sprint through Flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  let movedInput: unknown;
  await ledger.writeIssue({
    ref: "ISSUE-15730",
    title: "Prevent prescribed fixes",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  });
  const workRuntime = testWorkRuntime({
    store,
    ledger,
    jira: {
      async viewIssue(key) {
        return { key, summary: key, status: "Ready for Dev", labels: [] };
      },
      async moveIssuesToActiveSprint(input) {
        movedInput = input;
        return {
          issueKeys: input.issueKeys,
          sprintId: 321,
          sprintName: "Sprint 321",
          boardId: 12,
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-move-sprint");

  const result = await workRuntime.moveIssuesToActiveSprint(session.id, ["ISSUE-15730"], { projectKey: "ISSUE" });
  const issue = await ledger.readIssue("ISSUE-15730");

  assert.deepEqual(movedInput, { issueKeys: ["ISSUE-15730"], projectKey: "ISSUE", boardId: undefined, sprintId: undefined });
  assert.deepEqual(result.issueKeys, ["ISSUE-15730"]);
  assert.equal(result.sprintId, 321);
  assert.equal(issue?.metadata.jiraSprintId, 321);
  assert.equal(issue?.metadata.jiraSprintName, "Sprint 321");
});

test("Work Runtime inspects queue from current Jira sprint before ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  await ledger.writeIssue({
    ref: "ISSUE-15697",
    title: "Stale closed bead",
    repoKeys: ["public_api"],
    state: "running",
    metadata: {
      "workflow.phase": "implementation",
    },
  });
  await ledger.writeIssue({
    ref: "ISSUE-15676",
    title: "Existing ledger title",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      "workflow.phase": "triage",
    },
  });

  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue() {
        throw new Error("viewIssue should not be needed for Jira queue search");
      },
      async searchCurrentUserOpenSprintIssues(limit?: number) {
        assert.equal(limit, 10);
        return [
          {
            key: "ISSUE-15676",
            summary: "Current sprint issue",
            status: "Ready for Dev",
            statusCategory: "new",
            labels: [],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);

  assert.deepEqual(queue.map((issue) => issue.ref), ["ISSUE-15676"]);
  assert.equal(queue[0].title, "Current sprint issue");
  assert.deepEqual(queue[0].repoKeys, ["app_api"]);
  assert.equal(queue[0].metadata["workflow.phase"], "triage");
  assert.equal(queue[0].metadata.jiraStatus, "Ready for Dev");
  assert.equal(await ledger.readIssue("ISSUE-15697").then((issue) => issue?.state), "running");
  assert.equal(await ledger.readIssue("ISSUE-15676").then((issue) => issue?.title), "Existing ledger title");
});

test("Work Runtime inspects current-user Jira backlog separately from sprint queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "flow"), { recursive: true });
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger: new MemoryWorkflowLedger(),
    projectRoot: root,
    jira: {
      async viewIssue() {
        throw new Error("viewIssue should not be needed for Jira backlog search");
      },
      async searchCurrentUserBacklogIssues(limit) {
        assert.equal(limit, 2);
        return [
          {
            key: "ISSUE-15730",
            summary: "Prevent host-ops autogenerated Jira issues from prescribing fixes",
            issueType: "Story",
            status: "Ready for Dev",
            statusCategory: "new",
            labels: ["flow"],
          },
        ];
      },
    },
  });

  const backlog = await workRuntime.inspectBacklog(2);

  assert.equal(backlog.length, 1);
  assert.equal(backlog[0].ref, "ISSUE-15730");
  assert.deepEqual(backlog[0].repoKeys, ["main"]);
  assert.equal(backlog[0].metadata.jiraStatus, "Ready for Dev");
});

test("Work Runtime excludes done Jira issues defensively", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue() {
        throw new Error("viewIssue should not be needed for Jira queue search");
      },
      async searchCurrentUserOpenSprintIssues() {
        return [
          {
            key: "ISSUE-15697",
            summary: "Closed issue",
            status: "Closed",
            statusCategory: "done",
            resolution: "Done",
            labels: [],
          },
          {
            key: "ISSUE-15676",
            summary: "Current sprint issue",
            status: "In Progress",
            labels: [],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);

  assert.deepEqual(queue.map((issue) => issue.ref), ["ISSUE-15676"]);
  assert.equal(await ledger.readIssue("ISSUE-15676"), undefined);
});

test("Work Runtime lets Jira review state override stale worker phase", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  await ledger.writeIssue({
    ref: "ISSUE-15382",
    title: "Stale implementation phase",
    repoKeys: ["app_api"],
    state: "blocked",
    metadata: {
      "workflow.phase": "implementation",
      "workflow.workers.pi.app_api.status": "blocked",
      "workflow.workers.pi.app_api.summary": "Old worker blocker",
    },
  });

  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue() {
        throw new Error("viewIssue should not be needed for Jira queue search");
      },
      async searchCurrentUserOpenSprintIssues() {
        return [
          {
            key: "ISSUE-15382",
            summary: "Current review issue",
            status: "In Review",
            labels: ["app_api"],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);
  const stored = await ledger.readIssue("ISSUE-15382");

  assert.equal(queue[0].state, "awaiting_human");
  assert.equal(stored?.state, "blocked");
  assert.equal(stored ? workItemToBeadsMetadata(stored)["workflow.phase"] : "", "blocked");
  assert.equal(queue[0].metadata.jiraStatus, "In Review");
});

test("Work Runtime replaces invalid stale routed repo keys from Jira labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  await ledger.writeIssue({
    ref: "ISSUE-15676",
    title: "Stale repo routing",
    repoKeys: ["HostProject"],
    state: "queued",
    metadata: {
      "workflow.repo": "HostProject",
    },
  });

  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue() {
        throw new Error("viewIssue should not be needed for Jira queue search");
      },
      async searchCurrentUserOpenSprintIssues() {
        return [
          {
            key: "ISSUE-15676",
            summary: "Current sprint issue",
            status: "In Progress",
            labels: ["app_api"],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);

  assert.equal(queue.length, 1);
  assert.equal(queue[0].ref, "ISSUE-15676");
  assert.deepEqual(queue[0].repoKeys, ["app_api"]);
});

test("Work Runtime infers app_api routing from Jira summary keywords", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();

  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue() {
        throw new Error("viewIssue should not be needed for Jira queue search");
      },
      async searchCurrentUserOpenSprintIssues() {
        return [
          {
            key: "ISSUE-15676",
            summary: "Provider unable to process files compared to AGI",
            status: "Ready for Dev",
            labels: [],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);

  assert.equal(queue.length, 1);
  assert.deepEqual(queue[0].repoKeys, ["app_api"]);
});

test("Work Runtime approval creates a handoff request", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-approve");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-3",
    title: "Create handoff",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });
  const pending = await workRuntime.advanceIssue(session.id);
  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);

  const approved = await workRuntime.advanceIssue(session.id, confirmationId);

  assert.equal(approved.status, "execution_handoff");
  assert.equal(approved.handoffRequest?.issueRef, "ISSUE-3");
  assert.ok(approved.handoffRequest?.workJobId);
  assert.match(approved.handoffRequest?.prompt ?? "", /Use Flow to work this prompt/);
  const jobs = await workRuntime.listWorkJobs(session.id, "ISSUE-3");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].workType, "flow.implement");
  assert.equal(jobs[0].status, "queued");
  assert.equal(approved.handoffRequest?.workJobId, jobs[0].id);
});

test("Work Runtime prepares bug-prefixed branches from agent-selected branch kind", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const repoPath = join(root, "app-api");
  await mkdir(repoPath, { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  let preparedBranch = "";
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    git: {
      async inspect() {
        return { branch: "bug/issue-15738-geoparquet-provider-etl-fails", headSha: "abc123", dirty: false, entries: [] };
      },
      async prepareWorktree(plan) {
        preparedBranch = plan.branch;
        return { branch: plan.branch, headSha: "abc123", dirty: false, entries: [] };
      },
    },
  });
  const session = await workRuntime.createSession("session-bug-branch");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15738",
    title: "GeoParquet Provider ETL fails on GeoArrow WKB parquet schema",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: { jiraIssueType: "Bug", branchKind: "bug" },
  });

  await workRuntime.prepareWorkspace(session.id, "ISSUE-15738", { repoKey: "app_api", baseBranch: "release/2026.6.0" });

  assert.equal(preparedBranch, "bug/issue-15738-geoparquet-provider-etl-fails-on-geoarrow-wkb-parquet-sc");
});

test("Work Runtime blocks generated branches when branch kind is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const repoPath = join(root, "app-api");
  await mkdir(repoPath, { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree() {
        throw new Error("prepareWorktree should not run without branch kind");
      },
    },
  });
  const session = await workRuntime.createSession("session-missing-branch-kind");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15747",
    title: "Provider upload batch completion regression",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: {},
  });

  await assert.rejects(
    workRuntime.prepareWorkspace(session.id, "ISSUE-15747", { repoKey: "app_api" }),
    /branch kind is missing/,
  );
});

test("Work Runtime infers generated branch kind from Jira issue type", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let preparedBranch = "";
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan) {
        preparedBranch = plan.branch;
        return { branch: plan.branch, headSha: "abc123", dirty: false, entries: [] };
      },
    },
  });
  const session = await workRuntime.createSession("session-infer-branch-kind");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15720",
    title: "Partner PartnerCloud Provider Integration",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: { jiraIssueType: "Story" },
  });

  await workRuntime.prepareWorkspace(session.id, "ISSUE-15720", { repoKey: "app_api" });

  assert.equal(preparedBranch, "feature/issue-15720-partner-partnercloud-provider-integration");
});

test("Work Runtime moves Ready for Dev issue to In Progress after workspace prep", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const transitions: Array<{ key: string; status: string }> = [];
  let jiraStatus = "Ready for Dev";
  let jiraStatusCategory = "new";
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue(key) {
        return {
          key,
          summary: "Partner PartnerCloud Provider Integration",
          status: jiraStatus,
          statusCategory: jiraStatusCategory,
          labels: [],
        };
      },
      async transitionIssueToStatus(key, status) {
        transitions.push({ key, status });
        jiraStatus = status;
        jiraStatusCategory = "indeterminate";
      },
    },
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan) {
        return { branch: plan.branch, headSha: "abc123", dirty: false, entries: [] };
      },
    },
  });
  const session = await workRuntime.createSession("session-transition-in-progress");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15720",
    title: "Partner PartnerCloud Provider Integration",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: {
      branchKind: "feature",
      jiraStatus: "Ready for Dev",
      jiraStatusCategory: "new",
    },
  });

  const prepared = await workRuntime.prepareWorkspace(session.id, "ISSUE-15720", { repoKey: "app_api" });

  assert.deepEqual(transitions, [{ key: "ISSUE-15720", status: "In Progress" }]);
  assert.equal(prepared.metadata.jiraStatus, "In Progress");
  assert.equal(prepared.metadata.jiraStatusCategory, "indeterminate");
});

test("Work Runtime persists worker results through the workflow ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-ledger");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-4",
    title: "Use ledger",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  await workRuntime.recordWorkerResult(session.id, {
    taskId: "worker-4",
    issueRef: "ISSUE-4",
    repoKey: "app_api",
    status: "blocked",
    summary: "Need operator input",
    changedFiles: [],
    testsRun: [],
    blockers: ["operator input required"],
    completedAt: nowIso(),
  });

  const results = await ledger.listWorkerResults("ISSUE-4");
  const runs = await ledger.listWorkerRuns("ISSUE-4");
  const issue = await ledger.readIssue("ISSUE-4");
  assert.equal(results.length, 1);
  assert.equal(runs[0].status, "blocked");
  assert.equal(results[0].summary, "Need operator input");
  assert.equal(issue?.state, "blocked");
});

test("Workflow ledger upserts Worker results by task id", async () => {
  const ledger = new MemoryWorkflowLedger();
  await ledger.recordWorkerResult({
    taskId: "worker-10",
    issueRef: "ISSUE-10",
    repoKey: "app_api",
    status: "blocked",
    summary: "Missing pytest",
    changedFiles: [],
    testsRun: [],
    blockers: ["pytest unavailable"],
    completedAt: nowIso(),
  });

  await ledger.recordWorkerResult({
    taskId: "worker-10",
    issueRef: "ISSUE-10",
    repoKey: "app_api",
    status: "succeeded",
    summary: "Verified",
    changedFiles: [],
    testsRun: ["pixi run pytest"],
    blockers: [],
    completedAt: nowIso(),
  });

  const results = await ledger.listWorkerResults("ISSUE-10");
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "succeeded");
  assert.equal(results[0].blockers.length, 0);
});

test("Mirrored workflow ledger keeps primary authoritative when mirror fails", async () => {
  const primary = new MemoryWorkflowLedger();
  const mirrored = new MirroredWorkflowLedger(primary, {
    async mirrorIssue() {
      throw new Error("mirror unavailable");
    },
    async mirrorWorkerRun() {
      throw new Error("mirror unavailable");
    },
    async mirrorWorkerResult() {
      throw new Error("mirror unavailable");
    },
    async mirrorWorkJob() {
      throw new Error("mirror unavailable");
    },
    async mirrorWorkJobResult() {
      throw new Error("mirror unavailable");
    },
  });

  const stored = await mirrored.ensureIssue({
    ref: "ISSUE-88",
    title: "Mirror should not gate writes",
    repoKeys: ["main"],
    state: "selected",
    metadata: {},
  });
  const readBack = await primary.readIssue("ISSUE-88");

  assert.equal(stored.ref, "ISSUE-88");
  assert.equal(readBack?.state, "selected");
});

test("Flow workflow ledger persists records to local JSONL by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-ledger-"));
  const ledger = createWorkflowLedger({ cwd: root });
  await ledger.writeIssue({
    ref: "ISSUE-90",
    title: "Native ledger",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  });
  await ledger.recordWorkerResult({
    taskId: "worker-90",
    issueRef: "ISSUE-90",
    repoKey: "main",
    status: "succeeded",
    summary: "done",
    changedFiles: [],
    testsRun: [],
    blockers: [],
    completedAt: nowIso(),
  });

  const reloaded = createWorkflowLedger({ cwd: root });
  assert.equal((await reloaded.readIssue("ISSUE-90"))?.title, "Native ledger");
  assert.equal((await reloaded.listWorkerResults("ISSUE-90"))[0]?.taskId, "worker-90");
  const projection = JSON.parse(await readFile(flowIssueProjectionPath(root, "ISSUE-90"), "utf8"));
  assert.equal(projection.issue.title, "Native ledger");
  assert.equal(projection.workerRuns[0].taskId, "worker-90");
  assert.equal(projection.workerResults[0].taskId, "worker-90");
});

test("Flow context records validate prompt routing metadata", () => {
  const now = nowIso();
  const record = flowContextRecordSchema.parse({
    kind: "prompt",
    id: "prompt-1",
    projectId: "flow",
    issueRef: "ISSUE-58",
    threadId: "thread-1",
    sessionId: "session-1",
    artifactRefs: ["artifact-1"],
    prompt: "Render the artifact canvas.",
    target: "artifact",
    summary: "Canvas prompt",
    createdAt: now,
    updatedAt: now,
  });

  assert.equal(record.kind, "prompt");
  assert.equal(record.projectId, "flow");
  assert.equal(record.issueRef, "ISSUE-58");
  assert.equal(record.threadId, "thread-1");
  assert.equal(record.sessionId, "session-1");
  assert.deepEqual(record.artifactRefs, ["artifact-1"]);
});

test("Workflow ledger persists prompt, thread, session, and artifact context", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-context-ledger-"));
  const ledger = createWorkflowLedger({ cwd: root });
  assert.ok(ledger.recordContext);
  assert.ok(ledger.readContext);
  const now = nowIso();

  await ledger.recordContext({
    kind: "thread",
    id: "thread-1",
    projectId: "flow",
    issueRef: "ISSUE-58",
    title: "Desktop canvas direction",
    createdAt: now,
    updatedAt: now,
    metadata: {},
  });
  await ledger.recordContext({
    kind: "session",
    id: "session-1",
    projectId: "flow",
    issueRef: "ISSUE-58",
    threadId: "thread-1",
    provider: "pi",
    workspacePath: root,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  });
  await ledger.recordContext({
    kind: "artifact",
    id: "artifact-1",
    projectId: "flow",
    issueRef: "ISSUE-58",
    threadId: "thread-1",
    sessionId: "session-1",
    artifactType: "html",
    title: "Dashboard preview",
    uri: "artifact://artifact-1",
    createdAt: now,
    updatedAt: now,
    metadata: {},
  });
  await ledger.recordContext({
    kind: "prompt",
    id: "prompt-1",
    projectId: "flow",
    issueRef: "ISSUE-58",
    threadId: "thread-1",
    sessionId: "session-1",
    artifactRefs: ["artifact-1"],
    prompt: "Improve the dashboard preview.",
    target: "artifact",
    createdAt: now,
    updatedAt: now,
    metadata: {},
  });

  const reloaded = createWorkflowLedger({ cwd: root });
  assert.ok(reloaded.readContext);
  const projection = await reloaded.readContext({ projectId: "flow" });
  const storedProjection = JSON.parse(await readFile(flowContextProjectionPath(root), "utf8"));

  assert.equal(projection.active.projectId, "flow");
  assert.equal(projection.active.threadId, "thread-1");
  assert.equal(projection.active.sessionId, "session-1");
  assert.equal(projection.active.artifactId, "artifact-1");
  assert.equal(projection.threads[0].title, "Desktop canvas direction");
  assert.equal(projection.sessions[0].provider, "pi");
  assert.equal(projection.artifacts[0].artifactType, "html");
  assert.equal(projection.prompts[0].prompt, "Improve the dashboard preview.");
  assert.equal(storedProjection.prompts[0].id, "prompt-1");
});

test("Flow workflow ledger verification rebuilds issue projections", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-ledger-"));
  const ledger = createWorkflowLedger({ cwd: root });
  await ledger.writeIssue({
    ref: "ISSUE-91",
    title: "Projection rebuild",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  });
  await writeFile(flowIssueProjectionPath(root, "ISSUE-91"), "{\"issue\":{\"title\":\"stale\"}}\n", "utf8");

  const result = await verifyJsonlWorkflowLedger(join(root, ".flow", "ledger", "workflow.jsonl"), {
    rebuildProjections: true,
  });
  const projection = JSON.parse(await readFile(flowIssueProjectionPath(root, "ISSUE-91"), "utf8"));

  assert.equal(result.ok, true);
  assert.equal(result.validRecords, 1);
  assert.equal(result.rebuiltProjections, 1);
  assert.equal(projection.issue.title, "Projection rebuild");
});

test("Flow workflow ledger verification rebuilds context projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-context-rebuild-"));
  const ledger = createWorkflowLedger({ cwd: root });
  assert.ok(ledger.recordContext);
  await ledger.recordContext({
    kind: "thread",
    id: "thread-rebuild",
    projectId: "flow",
    title: "Rebuild context projection",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    metadata: {},
  });
  await writeFile(flowContextProjectionPath(root), "{\"threads\":[]}\n", "utf8");

  const result = await verifyJsonlWorkflowLedger(join(root, ".flow", "ledger", "workflow.jsonl"), {
    rebuildProjections: true,
  });
  const projection = JSON.parse(await readFile(flowContextProjectionPath(root), "utf8"));

  assert.equal(result.ok, true);
  assert.equal(result.validRecords, 1);
  assert.equal(result.rebuiltProjections, 1);
  assert.equal(projection.threads[0].id, "thread-rebuild");
});

test("Flow workflow ledger verification reports malformed records", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-ledger-"));
  const ledgerPath = join(root, ".flow", "ledger", "workflow.jsonl");
  await mkdir(dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, "{\"kind\":\"unknown\",\"value\":{}}\nnot-json\n", "utf8");

  const result = await verifyJsonlWorkflowLedger(ledgerPath, { rebuildProjections: true });

  assert.equal(result.ok, false);
  assert.equal(result.invalidRecords, 2);
  assert.equal(result.rebuiltProjections, 0);
  assert.match(result.diagnostics[0].message, /Unsupported ledger record kind/);
});

test("Workflow ledger upserts typed work jobs and results", async () => {
  const ledger = new MemoryWorkflowLedger();
  const now = nowIso();
  await ledger.recordWorkJob({
    id: "job-10",
    issueRef: "ISSUE-10",
    repoKey: "app_api",
    workType: "flow.implement",
    status: "queued",
    input: {},
    requiredCapabilities: ["code.edit"],
    createdAt: now,
    updatedAt: now,
  });
  await ledger.recordWorkJob({
    id: "job-10",
    issueRef: "ISSUE-10",
    repoKey: "app_api",
    workType: "flow.implement",
    status: "running",
    input: {},
    requiredCapabilities: ["code.edit"],
    claimedBy: "live_agent_thread",
    createdAt: now,
    updatedAt: nowIso(),
  });
  await ledger.recordWorkJobResult({
    jobId: "job-10",
    issueRef: "ISSUE-10",
    repoKey: "app_api",
    workType: "flow.implement",
    status: "succeeded",
    summary: "Done",
    evidence: ["npm test"],
    completedAt: nowIso(),
  });

  const jobs = await ledger.listWorkJobs("ISSUE-10");
  const results = await ledger.listWorkJobResults("ISSUE-10");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "running");
  assert.equal(jobs[0].claimedBy, "live_agent_thread");
  assert.equal(results.length, 1);
  assert.equal(results[0].summary, "Done");
});

test("Work Runtime does not create typed work while a Worker is active for the issue", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-active-worker-guard");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-71",
    title: "Already running",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
    },
  });
  await ledger.recordWorkerRun({
    taskId: "worker-active",
    issueRef: "ISSUE-71",
    repoKey: "app_api",
    status: "running",
    workspacePath: "/tmp/app-api-worktree",
    summary: "Worker started.",
    blockers: [],
    startedAt: nowIso(),
    updatedAt: nowIso(),
  });

  const result = await workRuntime.advanceIssue(session.id);
  const jobs = await ledger.listWorkJobs("ISSUE-71");
  const queue = await workRuntime.inspectDashboardQueue(10);

  assert.equal(result.status, "blocked");
  assert.match(result.message, /Execution handoff is already active/);
  assert.equal(jobs.length, 0);
  assert.equal(queue.find((issue) => issue.ref === "ISSUE-71")?.workStatus, "Running");
});

test("Dashboard queue mirrors provider-neutral issue status without provider URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-dashboard-queue-"));
  const ledger = new MemoryWorkflowLedger();
  const issueUrl = "https://github.com/example/flow/issues/9";
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-9",
    title: "Mirror generic provider metadata",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      issueStatus: "Open",
      issueStatusCategory: "To Do",
      issueType: "task",
      issueUrl,
      issueLabels: ["app_api"],
      "workflow.external.issue.status": "published",
      "workflow.external.code_review.status": "unpublished",
      branchKind: "feature",
    },
  });

  const queue = await workRuntime.inspectDashboardQueue(10);

  assert.equal(queue[0].ref, "GH-9");
  assert.equal(queue[0].statusLabel, "Open");
  assert.equal(Object.hasOwn(queue[0] as unknown as Record<string, unknown>, "issueUrl"), false);
});

test("Dashboard queue reads ledger state without provider refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-dashboard-ledger-only-"));
  const ledger = new MemoryWorkflowLedger();
  let issueTrackerCalls = 0;
  let collaborationCalls = 0;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    issueTracker: {
      capabilities: {
        canCreateIssues: false,
        canTransitionIssues: false,
        canPostComments: false,
        canManageActivePlanningLane: false,
      },
      async getIssue(ref) {
        issueTrackerCalls += 1;
        throw new Error(`provider refresh should not run for ${ref}`);
      },
      async fetchActiveQueue() {
        issueTrackerCalls += 1;
        throw new Error("provider queue should not run");
      },
    },
    collaboration: {
      capabilities: {
        canMarkReady: false,
        canPostComments: false,
        canMerge: false,
      },
      async findCodeReviews() {
        collaborationCalls += 1;
        throw new Error("code review refresh should not run");
      },
    },
  });
  await ledger.writeIssue({
    ref: "ISSUE-100",
    title: "Ledger dashboard item",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  const queue = await workRuntime.inspectDashboardQueue(10);

  assert.equal(queue.find((issue) => issue.ref === "ISSUE-100")?.title, "Ledger dashboard item");
  assert.equal(issueTrackerCalls, 0);
  assert.equal(collaborationCalls, 0);
});

test("Dashboard queue reconciles and hides closed issue tracker records", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-dashboard-closed-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-166-CLOSED",
    title: "Closed stale issue",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: {
      issueStatus: "Closed",
      issueStatusCategory: "Complete",
      issueResolution: "Done",
    },
  });
  await ledger.writeIssue({
    ref: "GH-166-OPEN",
    title: "Open issue",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      issueStatus: "Open",
      issueStatusCategory: "To Do",
    },
  });

  const queue = await workRuntime.inspectDashboardQueue(10);
  const closed = await ledger.readIssue("GH-166-CLOSED");

  assert.equal(queue.some((issue) => issue.ref === "GH-166-CLOSED"), false);
  assert.equal(queue.some((issue) => issue.ref === "GH-166-OPEN"), true);
  assert.equal(closed?.state, "done");
});

test("Dashboard queue omits source-control and provider internals", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-dashboard-public-contract-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "ISSUE-80",
    title: "Prepared local workspace",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.branch": "feature/issue-80-work",
      "workflow.repos.app_api.head_sha": "abc123",
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-80-work",
    },
  });

  const queue = await workRuntime.inspectDashboardQueue(10);
  const issue = queue.find((candidate) => candidate.ref === "ISSUE-80") as Record<string, unknown> | undefined;

  assert.ok(issue);
  assert.equal(Object.hasOwn(issue, "branch"), false);
  assert.equal(Object.hasOwn(issue, "repoKeys"), false);
  assert.deepEqual(issue.repositories, ["app_api"]);
  assert.equal(Object.hasOwn(issue, "headSha"), false);
  assert.equal(Object.hasOwn(issue, "worktreePath"), false);
  assert.equal(Object.hasOwn(issue, "issueUrl"), false);
  assert.equal(Object.hasOwn(issue, "prUrl"), false);
});

test("Dashboard queue derives work status from Flow artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-dashboard-real-status-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "ISSUE-90",
    title: "Merged dashboard polish",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/20",
      prState: "MERGED",
      prMergedAt: nowIso(),
    },
  });
  await ledger.writeIssue({
    ref: "ISSUE-91",
    title: "Blocked worker",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });
  await ledger.writeIssue({
    ref: "ISSUE-92",
    title: "Open review",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/21",
      prState: "OPEN",
      prIsDraft: false,
      prChecksPassing: true,
    },
  });
  await ledger.writeIssue({
    ref: "ISSUE-93",
    title: "Successful handoff",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });
  await ledger.recordWorkerResult({
    taskId: "worker-91",
    issueRef: "ISSUE-91",
    repoKey: "app_api",
    status: "blocked",
    summary: "Needs local input",
    changedFiles: [],
    testsRun: [],
    blockers: ["Need local context"],
    completedAt: nowIso(),
  });
  await ledger.recordWorkerResult({
    taskId: "worker-93",
    issueRef: "ISSUE-93",
    repoKey: "app_api",
    status: "succeeded",
    summary: "Implementation complete",
    changedFiles: ["src/dashboard/main.tsx"],
    testsRun: ["npm test"],
    blockers: [],
    completedAt: nowIso(),
  });

  const queue = await workRuntime.inspectDashboardQueue(10);

  assert.equal(queue.find((issue) => issue.ref === "ISSUE-90")?.workStatus, "Done");
  assert.match(queue.find((issue) => issue.ref === "ISSUE-90")?.workStatusDetail ?? "", /#20 is merged/);
  assert.equal(queue.find((issue) => issue.ref === "ISSUE-91")?.workStatus, "Blocked");
  assert.match(queue.find((issue) => issue.ref === "ISSUE-91")?.workStatusDetail ?? "", /worker-91 is blocked/);
  assert.equal(queue.find((issue) => issue.ref === "ISSUE-92")?.workStatus, "In Review");
  assert.match(queue.find((issue) => issue.ref === "ISSUE-92")?.workStatusDetail ?? "", /#21 is open/);
  assert.equal(queue.find((issue) => issue.ref === "ISSUE-93")?.workStatus, "Ready");
  assert.match(queue.find((issue) => issue.ref === "ISSUE-93")?.workStatusDetail ?? "", /worker-93 succeeded/);
});

test("Dashboard queue mirrors the current session selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-dashboard-session-"));
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  const workRuntime = testWorkRuntime({ store, ledger });
  await ledger.writeIssue({
    ref: "ISSUE-1",
    title: "Stale selected issue",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: {},
  });
  await ledger.writeIssue({
    ref: "ISSUE-2",
    title: "Current session issue",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {},
  });
  const session = await workRuntime.createSession("session-dashboard-selection");
  await store.writeSession({
    ...session,
    selectedIssueRef: "ISSUE-2",
    selectedRepoKey: "app_api",
  });

  const queueWithoutSession = await workRuntime.inspectDashboardQueue(10);
  const queue = await workRuntime.inspectDashboardQueue(10, session.id);

  assert.equal(queueWithoutSession.find((issue) => issue.ref === "ISSUE-1")?.workStatus, "Queued");
  assert.equal(queueWithoutSession.find((issue) => issue.ref === "ISSUE-2")?.workStatus, "Ready");
  assert.equal(queue.find((issue) => issue.ref === "ISSUE-1")?.workStatus, "Queued");
  assert.equal(queue.find((issue) => issue.ref === "ISSUE-2")?.workStatus, "Active");
});

test("Work Runtime blocked handoff includes copy-ready handoff prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-blocked-handoff-prompt");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-77",
    title: "Needs local intervention",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });

  await workRuntime.recordWorkerResult(session.id, {
    taskId: "worker-77",
    issueRef: "ISSUE-77",
    repoKey: "app_api",
    status: "blocked",
    summary: "Worker needs human context",
    changedFiles: [],
    testsRun: [],
    blockers: ["Need operator to inspect production evidence"],
    nextPickup: "Paste the handoff prompt into a local agent thread.",
    handoffPrompt: "Take over ISSUE-77 from Flow.",
    completedAt: nowIso(),
  });

  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(advanced.status, "blocked");
  assert.match(advanced.message, /Copy-ready handoff prompt/);
  assert.match(advanced.message, /Take over ISSUE-77 from Flow/);
});

test("Work Runtime blocked message suppresses obsolete satisfied PR executor prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-obsolete-pr-worker");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15272",
    title: "Coverage PR",
    repoKeys: ["app_api"],
    state: "blocked",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1344",
      prNumber: 1344,
      prIsDraft: false,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      prAutoReviewNeedsConfirmation: true,
      prAutoReviewNeedsConfirmationDetail: "Confirm pixi.lock truly does not change.",
      evidenceRecorded: true,
      documentationRecorded: true,
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-ISSUE-15272-test-coverage-ci",
    },
  });

  await workRuntime.recordWorkerResult(session.id, {
    taskId: "worker-issue-15272-undraft-pr1406",
    issueRef: "ISSUE-15272",
    repoKey: "app_api",
    status: "blocked",
    summary: "Agent handoff could not find provider credentials.",
    changedFiles: [],
    testsRun: [],
    blockers: ["Agent handoff could not find provider credentials."],
    nextPickup: "Configure credentials, then undraft PR #1406.",
    handoffPrompt: "Convert PR https://github.com/ExampleOrg/app-api/pull/1406 from draft to ready for review.",
    completedAt: nowIso(),
  });

  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(advanced.status, "blocked");
  assert.match(advanced.message, /Auto review requires confirmation/);
  assert.doesNotMatch(advanced.message, /1406/);
  assert.doesNotMatch(advanced.message, /provider credentials/);
  assert.doesNotMatch(advanced.message, /Copy-ready handoff prompt/);
});

test("Work Runtime synthesizes paste-ready handoff for existing blocked handoffs", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-legacy-blocked-handoff");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-78",
    title: "Existing blocked handoff",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-78",
    },
  });

  await workRuntime.recordWorkerResult(session.id, {
    taskId: "worker-78",
    issueRef: "ISSUE-78",
    repoKey: "app_api",
    status: "blocked",
    summary: "Worker stopped before local inspection",
    changedFiles: [],
    testsRun: [],
    blockers: ["Needs local operator context"],
    nextPickup: "Use a local agent thread.",
    completedAt: nowIso(),
  });

  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(advanced.status, "blocked");
  assert.match(advanced.message, /Copy-ready handoff prompt/);
  assert.match(advanced.message, /Use Flow to work this prompt/);
  assert.doesNotMatch(advanced.message, /Direct Jira\/GitHub/);
  assert.match(advanced.message, /feature-issue-78/);
  assert.match(advanced.message, /Requested work/);
});

test("Work Runtime lets a live agent thread adopt and close a handoff run", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-live-worker");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-30",
    title: "Live worker",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  });

  const request = await workRuntime.adoptLiveWorker(
    session.id,
    {
      id: "worker-live-1",
      issueRef: "ISSUE-30",
      repoKey: "main",
      prompt: "Do the live-thread work",
      workspacePath: "/repo/.worktrees/feature-issue-30-live-worker",
      createdAt: nowIso(),
    },
    { adopter: "agent-thread" },
  );
  const adoptedRuns = await workRuntime.observeWorkers(session.id);

  assert.equal(request.executor, "live_agent_thread");
  assert.ok(request.workJobId);
  assert.equal(adoptedRuns[0].executor, "live_agent_thread");
  assert.equal(adoptedRuns[0].status, "running");
  assert.match(adoptedRuns[0].summary ?? "", /agent-thread/);
  const adoptedJobs = await ledger.listWorkJobs("ISSUE-30");
  assert.equal(adoptedJobs.length, 1);
  assert.equal(adoptedJobs[0].claimedBy, "live_agent_thread");
  assert.equal(adoptedJobs[0].status, "running");

  await workRuntime.recordWorkerResult(session.id, {
    taskId: request.id,
    issueRef: request.issueRef,
    repoKey: request.repoKey,
    workJobId: request.workJobId,
    executor: "live_agent_thread",
    status: "succeeded",
    summary: "Live thread completed the handoff assignment.",
    changedFiles: ["src/work-runtime.ts"],
    testsRun: ["npm test"],
    blockers: [],
    completedAt: nowIso(),
  });

  const runs = await workRuntime.observeWorkers(session.id);
  const results = await ledger.listWorkerResults("ISSUE-30");
  const jobs = await ledger.listWorkJobs("ISSUE-30");
  const jobResults = await ledger.listWorkJobResults("ISSUE-30");
  assert.equal(runs[0].status, "succeeded");
  assert.equal(runs[0].executor, "live_agent_thread");
  assert.equal(results[0].executor, "live_agent_thread");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "succeeded");
  assert.equal(jobResults[0].jobId, request.workJobId);
});

test("Work Runtime adopts the pending handoff request into a live thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-pending-live-worker");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-31",
    title: "Pending live worker",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-31",
    },
  });

  const request = await workRuntime.adoptPendingLiveWorker(session.id, { adopter: "agent-thread" });
  const runs = await workRuntime.observeWorkers(session.id);
  const jobs = await ledger.listWorkJobs("ISSUE-31");

  assert.equal(request.executor, "live_agent_thread");
  assert.equal(request.issueRef, "ISSUE-31");
  assert.equal(request.repoKey, "app_api");
  assert.ok(request.workJobId);
  assert.equal(request.workspacePath, "/repo/app-api/.worktrees/feature-issue-31");
  assert.equal(runs[0].taskId, request.id);
  assert.equal(runs[0].workJobId, request.workJobId);
  assert.equal(runs[0].executor, "live_agent_thread");
  assert.equal(runs[0].status, "running");
  assert.match(runs[0].summary ?? "", /agent-thread/);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, request.workJobId);
  assert.equal(jobs[0].status, "running");
  assert.equal(jobs[0].claimedBy, "live_agent_thread");
});

test("Work Runtime infers typed work job when live thread records result without workJobId", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-live-worker-result-infer-job");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-32",
    title: "Live worker result without job id",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-32",
    },
  });

  const request = await workRuntime.adoptPendingLiveWorker(session.id, { adopter: "agent-thread" });
  await workRuntime.recordWorkerResult(session.id, {
    taskId: request.id,
    issueRef: request.issueRef,
    repoKey: request.repoKey,
    executor: "live_agent_thread",
    status: "succeeded",
    summary: "Agent thread completed the handoff assignment.",
    changedFiles: ["worker/tests/services/controller_data/etl/test_provider_parquet.py"],
    testsRun: ["pixi run pytest worker/tests/services/controller_data/etl/test_provider_parquet.py"],
    blockers: [],
    completedAt: nowIso(),
  });

  const results = await ledger.listWorkerResults("ISSUE-32");
  const jobs = await ledger.listWorkJobs("ISSUE-32");
  const jobResults = await ledger.listWorkJobResults("ISSUE-32");
  assert.equal(results[0].workJobId, request.workJobId);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "succeeded");
  assert.equal(jobResults.length, 1);
  assert.equal(jobResults[0].jobId, request.workJobId);
  assert.equal(jobResults[0].workerResult?.executor, "live_agent_thread");
});

test("Work Runtime records current local thread against a pending handoff request", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-agent-handoff-result");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-33",
    title: "Agent handoff result",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-33",
    },
  });

  const pending = await workRuntime.advanceIssue(session.id);
  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const requested = await workRuntime.advanceIssue(session.id, confirmationId);
  assert.equal(requested.status, "execution_handoff");

  const record = await workRuntime.recordLocalThreadResult(session.id, {
    issueRef: "ISSUE-33",
    repoKey: "app_api",
    status: "succeeded",
    summary: "Agent thread completed the handoff assignment.",
    changedFiles: ["src/work-runtime.ts"],
    testsRun: ["npm test"],
  });

  const results = await ledger.listWorkerResults("ISSUE-33");
  const runs = await ledger.listWorkerRuns("ISSUE-33");
  const jobs = await ledger.listWorkJobs("ISSUE-33");
  const jobResults = await ledger.listWorkJobResults("ISSUE-33");
  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(record.result.taskId, requested.handoffRequest?.id);
  assert.equal(record.result.workJobId, requested.handoffRequest?.workJobId);
  assert.equal(record.result.executor, "live_agent_thread");
  assert.equal(results[0].executor, "live_agent_thread");
  assert.equal(runs.at(-1)?.status, "succeeded");
  assert.equal(jobs[0].claimedBy, "live_agent_thread");
  assert.equal(jobs[0].status, "succeeded");
  assert.equal(jobResults[0].workerResult?.taskId, requested.handoffRequest?.id);
  assert.notEqual(advanced.session.pendingConfirmation?.action, "request_execution");
});

test("Work Runtime routes and prepares main work in the project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "host-root-"));
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger: new MemoryWorkflowLedger(),
    projectRoot,
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan) {
        assert.equal(plan.repoPath, projectRoot);
        assert.equal(plan.baseRef, "main");
        assert.match(plan.worktreePath, /\.worktrees\/feature-issue-31-flow-root-work$/);
        return {
          branch: plan.branch,
          headSha: "abcflow",
          dirty: false,
          entries: [],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-flow-route");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-31",
    title: "Flow root work",
    repoKeys: [],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const routed = await workRuntime.routeIssue(session.id, "ISSUE-31", ["main"]);
  const prepared = await workRuntime.prepareWorkspace(session.id, "ISSUE-31", { repoKey: "main" });

  assert.deepEqual(routed.repoKeys, ["main"]);
  assert.equal(prepared.metadata["workflow.repos.main.base_branch"], "main");
  assert.equal(
    prepared.metadata["workflow.repos.main.worktree_path"],
    `${projectRoot.replace(/\\/g, "/")}/.worktrees/feature-issue-31-flow-root-work`,
  );
});

test("Work Runtime autoflow stops at execution handoff confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-autoflow");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-16",
    title: "Autoflow",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });

  const result = await workRuntime.autoFlowIssue(session.id);

  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.workerResults.length, 0);
  assert.equal(result.steps.map((step) => step.status).join(","), "needs_confirmation");
  assert.equal(result.session.pendingConfirmation?.action, "request_execution");
  assert.equal(result.handoffRequest, undefined);
  const issue = await ledger.readIssue("ISSUE-16");
  assert.equal(issue?.metadata["workflow.autoflow.attempts"], 1);
  assert.equal(typeof issue?.metadata["workflow.autoflow.last_attempted_at"], "string");
});

test("Work Runtime resets Autoflow attempt state through Flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-autoflow-reset");
  await ledger.writeIssue({
    ref: "ISSUE-17",
    title: "Autoflow reset",
    repoKeys: ["main"],
    state: "blocked",
    metadata: {
      "workflow.autoflow.attempts": 3,
      "workflow.autoflow.last_attempted_at": "2026-05-15T20:00:00.000Z",
      "workflow.autoflow.current_action": "mark_pr_ready_for_review",
      "workflow.autoflow.current_action_started_at": "2026-05-15T20:00:00.000Z",
    },
  });

  const [reset] = await workRuntime.resetAutoflowState(session.id, ["ISSUE-17"]);

  assert.equal(reset.ref, "ISSUE-17");
  assert.equal(reset.metadata["workflow.autoflow.attempts"], 0);
  assert.equal(reset.metadata["workflow.autoflow.last_attempted_at"], "");
  assert.equal(reset.metadata["workflow.autoflow.current_action"], "");
  assert.equal(reset.metadata["workflow.autoflow.current_action_started_at"], "");
});

test("Work Runtime autoflow prepares a missing workspace before execution handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan) {
        assert.equal(plan.repoPath, "/repo/app-api");
        assert.equal(plan.baseRef, "develop");
        return {
          branch: plan.branch,
          headSha: "abc123",
          dirty: false,
          entries: [],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-autoflow-prepare");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-17",
    title: "Autoflow prepare",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const result = await workRuntime.autoFlowIssue(session.id);

  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.workerResults.length, 0);
  assert.equal(result.steps.map((step) => step.session.pendingConfirmation?.action).join(","), "prepare_workspace,request_execution");
  assert.equal(result.issue?.metadata["workflow.repos.app_api.worktree_path"], "/repo/app-api/.worktrees/feature-issue-17-autoflow-prepare");
});

test("Work Runtime autoflow marks draft pull requests ready before reassessing blockers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let markedReady: { repo: string; number: number } | undefined;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
      async findPullRequests() {
        return [];
      },
      async getPullRequest(repo, number) {
        return {
          repo,
          number,
          title: "Draft PR",
          url: `https://github.com/ExampleOrg/${repo}/pull/${number}`,
          headRefName: "feature/ISSUE-20-draft",
          state: "OPEN",
          isDraft: markedReady ? false : true,
          checksPassing: true,
          autoReviewStatus: "passed",
        };
      },
      async markPullRequestReadyForReview(repo, number) {
        markedReady = { repo, number };
        return this.getPullRequest?.(repo, number);
      },
    },
  });
  const session = await workRuntime.createSession("session-autoflow-pr-ready");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-20",
    title: "Draft PR",
    repoKeys: ["app_api"],
    state: "blocked",
    metadata: {
      prRepo: "app-api",
      prNumber: 20,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/20",
      prIsDraft: true,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      "workflow.repos.app_api.pr_repo": "app-api",
      "workflow.repos.app_api.pr_number": 20,
      "workflow.repos.app_api.pr_url": "https://github.com/ExampleOrg/app-api/pull/20",
      "workflow.repos.app_api.pr_is_draft": true,
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-20-draft",
    },
  });

  const result = await workRuntime.autoFlowIssue(session.id);

  assert.deepEqual(markedReady, { repo: "app-api", number: 20 });
  assert.equal(result.steps.map((step) => step.status).join(","), "blocked,needs_confirmation");
  const issue = await ledger.readIssue("ISSUE-20");
  assert.equal(issue?.metadata["workflow.autoflow.current_action"], "mark_pr_ready_for_review");
  assert.equal(issue?.metadata["workflow.autoflow.attempts"], 1);
});

test("Work Runtime records evidence and documentation handoff metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-handoff-records");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-12",
    title: "Handoff records",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  await workRuntime.recordEvidence(session.id, {
    issueRef: "ISSUE-12",
    summary: "Focused pytest passed.",
    source: "pixi run pytest",
  });
  await workRuntime.recordDocumentation(session.id, {
    issueRef: "ISSUE-12",
    disposition: "not_needed",
    summary: "Internal processing fix only.",
  });

  const issue = await ledger.readIssue("ISSUE-12");
  assert.equal(issue?.metadata.evidenceRecorded, true);
  assert.equal(issue?.metadata.documentationRecorded, true);
});

test("Work Runtime writes acceptance evidence back to Jira once", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const comments: Array<{ key: string; body: string }> = [];
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    jira: {
      async viewIssue(key) {
        return { key, summary: "Accepted issue", labels: [] };
      },
      async postIssueComment(key, body) {
        comments.push({ key, body });
        return { url: `https://example.atlassian.net/browse/${key}?focusedCommentId=10001`, body };
      },
    },
  });
  const session = await workRuntime.createSession("session-acceptance-writeback");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-18",
    title: "Closeout acceptance",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/18",
      prState: "OPEN",
      evidenceRecorded: true,
      evidenceSummary: "Focused pytest and PR checks passed.",
      evidenceSource: "pixi run pytest worker/tests/test_acceptance.py",
      evidenceCriteria: [
        {
          label: "Regression covered",
          status: "passed",
          evidence: "Focused pytest passed.",
          source: "worker/tests/test_acceptance.py",
        },
      ],
    },
  });

  const issue = await workRuntime.recordAcceptanceWriteback(session.id);
  const repeated = await workRuntime.recordAcceptanceWriteback(session.id);

  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.key, "ISSUE-18");
  assert.match(comments[0]?.body ?? "", /Acceptance evidence recorded for PR closeout/);
  assert.match(comments[0]?.body ?? "", /Regression covered: Focused pytest passed/);
  assert.equal(issue.state, "awaiting_review");
  assert.equal(repeated.metadata["workflow.acceptance.jira_written"], true);
  assert.equal(
    repeated.metadata["workflow.acceptance.jira_comment_url"],
    "https://example.atlassian.net/browse/ISSUE-18?focusedCommentId=10001",
  );
});

test("Work Runtime honors disabled issue tracker comment capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let commentAttempts = 0;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    issueTracker: {
      capabilities: {
        canCreateIssues: false,
        canTransitionIssues: false,
        canPostComments: false,
        canManageActivePlanningLane: false,
      },
      async getIssue(ref) {
        return {
          ref,
          title: "Capability issue",
          status: "In Review",
          type: "story",
          url: `https://tracker.example/${ref}`,
          labels: [],
        };
      },
      async postComment() {
        commentAttempts += 1;
        return { body: "should not post" };
      },
    },
  });
  const session = await workRuntime.createSession("session-comment-capability-disabled");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-902",
    title: "Capability writeback",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/902",
      evidenceRecorded: true,
      evidenceSummary: "Verified.",
      evidenceSource: "pytest",
    },
  });

  await assert.rejects(
    workRuntime.recordAcceptanceWriteback(session.id),
    /Jira comment writer is not configured/,
  );
  assert.equal(commentAttempts, 0);
});

test("Work Runtime accepts pure code collaboration providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    collaboration: {
      capabilities: {
        canMarkReady: true,
        canPostComments: false,
        canMerge: false,
      },
      async findCodeReviews(repo, branchName) {
        assert.equal(repo, "app-api");
        assert.equal(branchName, "feature/issue-903-provider-review");
        return [
          {
            id: 903,
            repo,
            url: "https://github.com/ExampleOrg/app-api/pull/903",
            title: "ISSUE-903 provider review",
            sourceBranch: branchName,
            targetBranch: "develop",
            isDraft: false,
            isMerged: false,
            isClosed: false,
            mergeableState: "clean",
            checksPassing: true,
            state: "OPEN",
            reviewDecision: "REVIEW_REQUIRED",
            templateMissingHeadings: [],
            autoReviewStatus: "passed",
            autoReviewMustFix: false,
            autoReviewNeedsConfirmation: false,
          },
        ];
      },
    },
  });
  await ledger.writeIssue({
    ref: "ISSUE-903",
    title: "Provider review",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      "workflow.repos.app_api.branch": "feature/issue-903-provider-review",
    },
  });
  const session = await workRuntime.createSession("session-provider-collaboration");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-903",
    title: "Provider review",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      "workflow.repos.app_api.branch": "feature/issue-903-provider-review",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id, "ISSUE-903");

  assert.equal(issue.metadata.prUrl, "https://github.com/ExampleOrg/app-api/pull/903");
  assert.equal(issue.metadata.prReviewDecision, "REVIEW_REQUIRED");
  assert.equal(issue.metadata.prChecksPassing, true);
});

test("Work Runtime closeout records evidence, merges approved PR, and verifies Jira automation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const comments: Array<{ key: string; body: string }> = [];
  let merged: { repo: string; number: number; method?: string } | undefined;
  let prMerged = false;
  let jiraReads = 0;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
      async findPullRequests() {
        return [];
      },
      async getPullRequest(repo, number) {
        return {
          repo,
          number,
          title: "Closeout PR",
          url: `https://github.com/ExampleOrg/${repo}/pull/${number}`,
          headRefName: "feature/ISSUE-19-closeout",
          state: prMerged ? "MERGED" : "OPEN",
          mergedAt: prMerged ? "2026-05-15T15:00:00Z" : undefined,
          mergeCommitSha: prMerged ? "abc123" : undefined,
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: "APPROVED",
          checksPassing: true,
          autoReviewStatus: "passed",
          autoReviewMustFix: false,
        };
      },
      async postPullRequestComment() {
        throw new Error("unexpected PR comment");
      },
      async mergePullRequest(repo, number, options) {
        merged = { repo, number, method: options?.method };
        prMerged = true;
        return {
          url: `https://github.com/ExampleOrg/${repo}/pull/${number}`,
          mergedAt: "2026-05-15T15:00:00Z",
          mergeCommitSha: "abc123",
        };
      },
    },
    jira: {
      async viewIssue(key) {
        jiraReads += 1;
        return {
          key,
          summary: "Closeout issue",
          status: jiraReads >= 2 ? "Ready for QA" : "In Review",
          statusCategory: jiraReads >= 2 ? "Done" : "In Progress",
          labels: [],
        };
      },
      async postIssueComment(key, body) {
        comments.push({ key, body });
        return { url: `https://example.atlassian.net/browse/${key}?focusedCommentId=20002`, body };
      },
    },
  });
  const session = await workRuntime.createSession("session-closeout-after-approval");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-19",
    title: "Approved closeout",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prRepo: "app-api",
      prNumber: 19,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/19",
      evidenceRecorded: true,
      evidenceSummary: "Acceptance criteria passed.",
      evidenceSource: "pixi run pytest tests/test_closeout.py",
      documentationRecorded: true,
      documentationDisposition: "not_needed",
      documentationSummary: "No user-facing docs needed.",
    },
  });

  const result = await workRuntime.closeoutAfterApproval(session.id, {
    jiraPollAttempts: 2,
    jiraPollIntervalMs: 0,
  });

  assert.equal(result.status, "merged_jira_verified");
  assert.deepEqual(merged, { repo: "app-api", number: 19, method: "squash" });
  assert.equal(comments.length, 1);
  assert.match(comments[0]?.body ?? "", /Acceptance evidence recorded for PR closeout/);
  assert.equal(result.acceptanceCommentUrl, "https://example.atlassian.net/browse/ISSUE-19?focusedCommentId=20002");
  assert.equal(result.jiraStatusBefore, "In Review");
  assert.equal(result.jiraStatusAfter, "Ready for QA");
  const issue = await ledger.readIssue("ISSUE-19");
  assert.equal(issue?.state, "done");
  assert.equal(issue?.metadata["workflow.closeout.status"], "merged_jira_verified");
  assert.equal(issue?.metadata["workflow.closeout.jira_verified"], true);
  assert.equal(issue?.metadata["workflow.closeout.merge_commit_sha"], "abc123");
});

test("Work Runtime records provider escalation as blocked workflow metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-provider-escalation");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-16",
    title: "Provider stuck processing",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  await workRuntime.recordProviderEscalation(session.id, {
    issueRef: "ISSUE-16",
    provider: "Provider",
    summary: "Provider uploaded files are stuck, but Jira has no concrete sample IDs.",
    blocker: "Need affected Provider file IDs or batch IDs before HostProject can reproduce or escalate.",
  });

  const issue = await ledger.readIssue("ISSUE-16");
  const escalation = issue?.metadata.externalProviderEscalation as Record<string, unknown> | undefined;
  assert.equal(issue?.state, "blocked");
  assert.equal(escalation?.provider, "Provider");
  assert.equal(escalation?.summary, "Provider uploaded files are stuck, but Jira has no concrete sample IDs.");
  assert.equal(
    escalation?.blocker,
    "Need affected Provider file IDs or batch IDs before HostProject can reproduce or escalate.",
  );
  assert.equal(typeof escalation?.recordedAt, "string");
});

test("Work Runtime issue selection preserves existing workflow metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-select-preserves");
  await ledger.writeIssue({
    ref: "ISSUE-17",
    title: "Existing provider blocker",
    repoKeys: ["app_api"],
    state: "blocked",
    metadata: {
      externalProviderEscalation: {
        provider: "Provider",
        summary: "Waiting on Provider samples.",
        blocker: "Need Provider batch IDs.",
        recordedAt: nowIso(),
      },
    },
  });

  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-17",
    title: "Existing provider blocker",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  const issue = await ledger.readIssue("ISSUE-17");
  assert.equal(issue?.state, "selected");
  assert.deepEqual(issue?.repoKeys, ["app_api"]);
  assert.equal(
    (issue?.metadata.externalProviderEscalation as Record<string, unknown> | undefined)?.blocker,
    "Need Provider batch IDs.",
  );
});

test("Work Runtime records pull request metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/issue-14-test",
          headSha: "abc123",
          dirty: false,
          entries: [],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-record");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-14",
    title: "PR metadata",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
    },
  });

  await workRuntime.recordPullRequest(session.id, {
    issueRef: "ISSUE-14",
    repo: "app-api",
    number: 1401,
    url: "https://github.com/ExampleOrg/app-api/pull/1401",
    headRefName: "feature/issue-14-test",
    isDraft: true,
  });

  const issue = await ledger.readIssue("ISSUE-14");
  assert.equal(issue?.metadata.prUrl, "https://github.com/ExampleOrg/app-api/pull/1401");
  assert.equal(issue?.metadata.prHeadRefName, "feature/issue-14-test");
  assert.equal(issue?.metadata["workflow.repos.app_api.pr_head_ref_name"], "feature/issue-14-test");
  assert.equal(issue?.metadata.prIsDraft, true);
  assert.equal(issue?.metadata["workflow.repos.app_api.head_sha"], "abc123");
  assert.equal(issue?.metadata["workflow.repos.app_api.dirty"], false);
});

test("Work Runtime records pull request metadata for repos outside configured topology", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
  });
  const session = await workRuntime.createSession("session-pr-external-record");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15407",
    title: "External PR metadata",
    repoKeys: [],
    state: "queued",
    metadata: {
      prRepo: "fs-python",
      prNumber: 1416,
      prUrl: "https://github.com/ExampleOrg/fs-python/pull/1416",
      "workflow.repos.fs_python.pr_repo": "fs-python",
      "workflow.repos.fs_python.pr_number": 1416,
      "workflow.repos.fs_python.pr_url": "https://github.com/ExampleOrg/fs-python/pull/1416",
    },
  });

  await workRuntime.recordPullRequest(session.id, {
    issueRef: "ISSUE-15407",
    repo: "fs-python",
    number: 1416,
    url: "https://github.com/ExampleOrg/fs-python/pull/1416",
    headRefName: "feature/issue-15407-sedona",
    isDraft: true,
  });

  const issue = await ledger.readIssue("ISSUE-15407");
  assert.deepEqual(issue?.repoKeys, []);
  assert.equal(issue?.metadata.prHeadRefName, "feature/issue-15407-sedona");
  assert.equal(issue?.metadata["workflow.repos.fs_python.pr_head_ref_name"], "feature/issue-15407-sedona");
});

test("Work Runtime reconciliation adopts matching pull request into Beads state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/issue-17-test",
          headSha: "def456",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "app-api");
        assert.equal(headRefName, "feature/issue-17-test");
        return [
          {
            repo,
            number: 17,
            title: "ISSUE-17",
            url: "https://github.com/ExampleOrg/app-api/pull/17",
            headRefName,
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: "REVIEW_REQUIRED",
            checksPassing: true,
          },
        ];
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-reconcile");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-17",
    title: "PR reconcile",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.equal(issue.metadata.prUrl, "https://github.com/ExampleOrg/app-api/pull/17");
  assert.equal(issue.metadata.prNumber, 17);
  assert.equal(issue.metadata.prIsDraft, false);
  assert.equal(issue.metadata.prMergeable, "MERGEABLE");
  assert.equal(issue.metadata.prMergeStateStatus, "CLEAN");
  assert.equal(issue.metadata.prReviewDecision, "REVIEW_REQUIRED");
  assert.equal(issue.metadata.humanReviewRequired, true);
  assert.equal(issue.metadata.prChecksPassing, true);
  assert.equal(issue.metadata["workflow.repos.app_api.head_sha"], "def456");
});

test("Work Runtime reconciliation discovers routing from an unrouted matching pull request", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
      async findPullRequests(repo) {
        if (repo !== "public-api") return [];
        return [
          {
            repo,
            number: 3026,
            title: "feat(ISSUE-15397): use shared flower task priorities",
            url: "https://github.com/ExampleOrg/public-api/pull/3026",
            headRefName: "feature/issue-15397-standardize-task-priority-constants",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "BLOCKED",
            reviewDecision: "REVIEW_REQUIRED",
            checksPassing: true,
            autoReviewStatus: "passed",
          },
        ];
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-discovers-route");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15397",
    title: "Standardize task priority into shared constants module",
    repoKeys: [],
    state: "ready_to_run",
    metadata: {},
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.deepEqual(issue.repoKeys, ["public_api"]);
  assert.equal(issue.metadata.prUrl, "https://github.com/ExampleOrg/public-api/pull/3026");
  assert.equal(issue.metadata.prNumber, 3026);
  assert.equal(issue.metadata.prReviewDecision, "REVIEW_REQUIRED");
  assert.equal(issue.metadata.humanReviewRequired, true);
  assert.equal(issue.metadata["workflow.repos.public_api.pr_url"], "https://github.com/ExampleOrg/public-api/pull/3026");
});

test("Work Runtime doctor reports visibility, blockers, and next action", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
      async findPullRequests(repo) {
        if (repo !== "public-api") return [];
        return [
          {
            repo,
            number: 3026,
            title: "feat(ISSUE-15397): use shared flower task priorities",
            url: "https://github.com/ExampleOrg/public-api/pull/3026",
            headRefName: "feature/issue-15397-standardize-task-priority-constants",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "BLOCKED",
            reviewDecision: "REVIEW_REQUIRED",
            checksPassing: true,
            autoReviewStatus: "passed",
            autoReviewMustFix: true,
            autoReviewMustFixDetail: "Resolve review feedback.",
          },
        ];
      },
    },
  });
  const session = await workRuntime.createSession("session-doctor");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15397",
    title: "Standardize task priority into shared constants module",
    repoKeys: [],
    state: "ready_to_run",
    metadata: {},
  });

  const result = await workRuntime.diagnoseIssue(session.id);

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.issue.repoKeys, ["public_api"]);
  assert.equal(result.visibility.repoRouting, true);
  assert.equal(result.visibility.codeReview, true);
  assert.equal(result.visibility.preparedWorktree, false);
  assert.equal(result.codeReview?.prUrl, "https://github.com/ExampleOrg/public-api/pull/3026");
  assert.equal(result.nextAction.type, "adopt_workspace");
  assert.match(result.nextAction.command ?? "", /"op":"issue","mode":"adoptWorkspace","id":"ISSUE-15397","repoKey":"public_api"/);
  assert.equal(
    result.findings.some((finding) => finding.summary === "Auto review has must-fix feedback."),
    true,
  );
});

test("Work Runtime doctor treats no PR as healthy when collaboration is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    collaboration: new NoopCodeCollaborationAdapter(),
  });
  const session = await workRuntime.createSession("session-doctor-no-pr");
  await workRuntime.selectIssue(session.id, {
    ref: "LOCAL-1",
    title: "Local-only work",
    repoKeys: ["public_api"],
    state: "selected",
    metadata: {
      "workflow.repos.public_api.worktree_path": "/repo/public-api/.worktrees/local-only-work",
    },
  });

  const result = await workRuntime.diagnoseIssue(session.id);

  assert.equal(result.status, "ok");
  assert.equal(result.visibility.codeReview, false);
  assert.equal(result.visibility.codeReviewRequired, false);
  assert.equal(result.nextAction.type, "advance");
});

test("Work Runtime doctor prioritizes present review comments before approval wait", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-doctor-review-comments");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-3026",
    title: "Review comments",
    repoKeys: ["public_api"],
    state: "awaiting_review",
    metadata: {
      "workflow.repos.public_api.worktree_path": "/repo/public-api/.worktrees/feature-issue-3026",
      prUrl: "https://github.com/ExampleOrg/public-api/pull/3026",
      prReviewDecision: "REVIEW_REQUIRED",
      humanReviewRequired: true,
      prReviewCommentCount: 3,
      prReviewCommentAuthors: ["khwiri", "developer-hla"],
      prChecksPassing: true,
      prIsDraft: false,
      prMergeable: "MERGEABLE",
      prMergeStateStatus: "BLOCKED",
    },
  });

  const result = await workRuntime.diagnoseIssue(session.id);

  assert.equal(result.nextAction.type, "address_review_comments");
  assert.equal(
    result.findings.some((finding) => finding.summary === "Review comments are present."),
    true,
  );
  assert.equal(
    result.findings.some((finding) => finding.summary === "Approval review is required."),
    true,
  );
});

test("Work Runtime doctor preserves awaiting review issue state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-doctor-awaiting-review");
  await ledger.writeIssue({
    ref: "ISSUE-77",
    title: "Review-ready issue",
    repoKeys: ["public_api"],
    state: "awaiting_review",
    metadata: {
      "workflow.repos.public_api.worktree_path": "/repo/public-api/.worktrees/issue-77",
      prUrl: "https://github.com/ExampleOrg/public-api/pull/77",
      prChecksPassing: true,
      prIsDraft: false,
    },
  });
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-77",
    title: "Review-ready issue",
    repoKeys: ["public_api"],
    state: "awaiting_review",
    metadata: {},
  });

  const result = await workRuntime.diagnoseIssue(session.id, "ISSUE-77");

  assert.equal(result.issue.state, "awaiting_review");
  assert.equal((await ledger.readIssue("ISSUE-77"))?.state, "awaiting_review");
});

test("Work Runtime doctor reports no next action for merged Done issue", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-doctor-done");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15397",
    title: "Merged and done",
    repoKeys: ["public_api"],
    state: "awaiting_review",
    metadata: {
      "workflow.repos.public_api.worktree_path": "/repo/public-api/.worktrees/feature-issue-15397",
      prUrl: "https://github.com/ExampleOrg/public-api/pull/3026",
      prState: "MERGED",
      prMergedAt: "2026-05-21T13:00:00Z",
      prChecksPassing: true,
      prIsDraft: false,
      jiraStatus: "Done",
      jiraStatusCategory: "Done",
      jiraResolution: "Done",
    },
  });

  const result = await workRuntime.diagnoseIssue(session.id);

  assert.equal(result.status, "ok");
  assert.equal(result.nextAction.type, "done");
  assert.match(result.nextAction.summary, /complete/);
});

test("Work Runtime reconciliation adopts open issue PR when branch has changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/issue-15607-old",
          headSha: "oldsha",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "app-api");
        if (headRefName) {
          assert.equal(headRefName, "feature/issue-15607-old");
          return [];
        }
        return [
          {
            repo,
            number: 1404,
            title: "ISSUE-15607 fix Panorama app key environment endpoint",
            url: "https://github.com/ExampleOrg/app-api/pull/1404",
            headRefName: "bug/ISSUE-15607-panorama-app-key-env",
            state: "OPEN",
            isDraft: true,
            mergeable: "MERGEABLE",
            mergeStateStatus: "BLOCKED",
            reviewDecision: "REVIEW_REQUIRED",
            checksPassing: false,
            autoReviewStatus: "failed",
          },
        ];
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-issue-key-fallback");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15607",
    title: "PR branch changed",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      jiraStatus: "In Review",
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
      "workflow.repos.app_api.pr_url": "https://github.com/ExampleOrg/app-api/pull/1385",
      "workflow.repos.app_api.pr_number": 1385,
      "workflow.repos.app_api.pr_repo": "app-api",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.equal(issue.metadata.prUrl, "https://github.com/ExampleOrg/app-api/pull/1404");
  assert.equal(issue.metadata.prNumber, 1404);
  assert.equal(issue.metadata.prIsDraft, true);
  assert.equal(issue.state, "blocked");
  assert.equal(issue.metadata["workflow.repos.app_api.pr_url"], "https://github.com/ExampleOrg/app-api/pull/1404");
  assert.equal(issue.metadata["workflow.repos.app_api.branch"], "feature/issue-15607-old");
});

test("Work Runtime reconciliation selects blocking pull request across routed repos", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/issue-15607-test",
          headSha: "abc15607",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
      async findPullRequests(repo, headRefName) {
        assert.equal(headRefName, "feature/issue-15607-test");
        if (repo === "public-api") {
          return [
            {
              repo,
              number: 2971,
              title: "ISSUE-15607",
              url: "https://github.com/ExampleOrg/public-api/pull/2971",
              headRefName,
              isDraft: false,
              mergeable: "MERGEABLE",
              mergeStateStatus: "BLOCKED",
              checksPassing: true,
              autoReviewStatus: "passed",
              autoReviewMustFix: true,
              autoReviewMustFixDetail: "New test files use // @ts-nocheck.",
            },
          ];
        }
        return [
          {
            repo,
            number: repo === "app-api" ? 1385 : 3178,
            title: "ISSUE-15607",
            url: `https://github.com/ExampleOrg/${repo}/pull/${repo === "app-api" ? 1385 : 3178}`,
            headRefName,
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            checksPassing: true,
            autoReviewStatus: "passed",
            autoReviewMustFix: false,
          },
        ];
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-aggregate");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15607",
    title: "Cross-repo PR aggregate",
    repoKeys: ["app_api", "public_api", "web_app"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
      "workflow.repos.public_api.worktree_path": "/tmp/public-api-worktree",
      "workflow.repos.web_app.worktree_path": "/tmp/web-app-worktree",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.equal(issue.metadata.prRepo, "public-api");
  assert.equal(issue.metadata.prNumber, 2971);
  assert.equal(issue.metadata.prUrl, "https://github.com/ExampleOrg/public-api/pull/2971");
  assert.equal(issue.metadata.prAutoReviewMustFix, true);
  assert.equal(issue.metadata.prAutoReviewMustFixDetail, "New test files use // @ts-nocheck.");
  assert.equal(issue.metadata["workflow.repos.web_app.pr_url"], "https://github.com/ExampleOrg/web-app/pull/3178");
});

test("Work Runtime turns remediable PR review blockers into handoff requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-review-remediation");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-72",
    title: "Fix review feedback",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
      prUrl: "https://github.com/ExampleOrg/app-api/pull/72",
      prIsDraft: false,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      prAutoReviewMustFix: true,
      prAutoReviewMustFixDetail: "Keep TEMP_PATH type-compatible by assigning Path(temp_path).",
    },
  });

  const pending = await workRuntime.advanceIssue(session.id);

  assert.equal(pending.status, "needs_confirmation");
  assert.equal(pending.session.pendingConfirmation?.action, "request_execution");
  assert.equal(pending.session.pendingConfirmation?.summary, "Hand off PR review remediation for ISSUE-72 in app_api.");

  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const approved = await workRuntime.advanceIssue(session.id, confirmationId);

  assert.equal(approved.status, "execution_handoff");
  assert.match(approved.handoffRequest?.prompt ?? "", /Prompt: address these review findings/);
  assert.match(approved.handoffRequest?.prompt ?? "", /Keep TEMP_PATH type-compatible/);
  const jobs = await ledger.listWorkJobs("ISSUE-72");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].workType, "flow.remediate");
  assert.equal(approved.handoffRequest?.workJobId, jobs[0].id);
});

test("Work Runtime turns failed PR checks into review remediation work", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-review-checks-remediation");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-73",
    title: "Fix failed PR checks",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
      prUrl: "https://github.com/ExampleOrg/app-api/pull/73",
      prIsDraft: false,
      prChecksPassing: false,
      prAutoReviewStatus: "failed",
    },
  });

  const pending = await workRuntime.advanceIssue(session.id);

  assert.equal(pending.status, "needs_confirmation");
  assert.equal(pending.session.pendingConfirmation?.action, "request_execution");
  assert.match(pending.session.pendingConfirmation?.summary ?? "", /Hand off PR review remediation/);
  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const approved = await workRuntime.advanceIssue(session.id, confirmationId);
  assert.equal(approved.status, "execution_handoff");
  assert.match(approved.handoffRequest?.prompt ?? "", /Pull request checks are not passing/);
  assert.match(approved.handoffRequest?.prompt ?? "", /Auto review checks failed/);
});

test("Work Runtime records review confirmation and posts it to GitHub", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let posted: { repo: string; number: number; body: string } | undefined;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
      async findPullRequests() {
        return [];
      },
      async postPullRequestComment(repo, number, body) {
        posted = { repo, number, body };
        return {
          url: `https://github.com/ExampleOrg/${repo}/pull/${number}#issuecomment-1`,
          body,
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-review-confirmation");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15676",
    title: "Provider confirmation",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prRepo: "app-api",
      prNumber: 1402,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1402",
      prIsDraft: false,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      prAutoReviewNeedsConfirmation: true,
      prAutoReviewNeedsConfirmationDetail: "Confirm Provider semantics.",
      evidenceRecorded: true,
      documentationRecorded: true,
    },
  });

  const issue = await workRuntime.recordReviewConfirmation(session.id, {
    issueRef: "ISSUE-15676",
    repo: "app-api",
    number: 1402,
    disposition: "accept",
    summary: "Confirmed from Provider docs and focused regression tests.",
    evidence: "Provider PROCESSED status plus batch status sections govern completion.",
    verification: "pixi run pytest worker/tests/services/provider/test_user_upload_batch_status.py",
  });

  assert.equal(posted?.repo, "app-api");
  assert.equal(posted?.number, 1402);
  assert.match(posted?.body ?? "", /Addressing the auto-review confirmation question for ISSUE-15676/);
  assert.match(posted?.body ?? "", /Confirmed from Provider docs and focused regression tests/);
  assert.doesNotMatch(posted?.body ?? "", /Disposition:/);
  assert.equal(issue.metadata.prAutoReviewNeedsConfirmationDisposition, "accept");
  assert.equal(
    issue.metadata.prAutoReviewNeedsConfirmationPostedUrl,
    "https://github.com/ExampleOrg/app-api/pull/1402#issuecomment-1",
  );
  assert.equal(
    issue.metadata["workflow.repos.app_api.pr_auto_review_needs_confirmation_disposition"],
    "accept",
  );

  const advanced = await workRuntime.advanceIssue(session.id);
  assert.equal(
    advanced.session.findings.some((finding) => finding.summary === "Auto review requires confirmation."),
    false,
  );
});

test("Work Runtime review confirmation replaces stale top-level PR metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
      async findPullRequests() {
        return [];
      },
    },
  });
  const session = await workRuntime.createSession("session-review-confirmation-stale-pr");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15272",
    title: "Coverage confirmation",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prRepo: "app-api",
      prNumber: 1406,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1406",
      prIsDraft: false,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      prAutoReviewNeedsConfirmation: true,
      prAutoReviewNeedsConfirmationDetail: "Confirm pixi.lock truly does not change.",
      evidenceRecorded: true,
      documentationRecorded: true,
      "workflow.repos.app_api.pr_number": 1344,
      "workflow.repos.app_api.pr_url": "https://github.com/ExampleOrg/app-api/pull/1344",
    },
  });

  const issue = await workRuntime.recordReviewConfirmation(session.id, {
    issueRef: "ISSUE-15272",
    repo: "app-api",
    number: 1344,
    disposition: "accept",
    summary: "pixi.toml changed only task command text and pixi.lock is unchanged.",
    verification: "pixi lock --check",
    githubCommentUrl: "https://github.com/ExampleOrg/app-api/pull/1344#issuecomment-1",
  });

  assert.equal(issue.metadata.prRepo, "app-api");
  assert.equal(issue.metadata.prNumber, 1344);
  assert.equal(issue.metadata.prUrl, "https://github.com/ExampleOrg/app-api/pull/1344");
  assert.equal(issue.metadata.prAutoReviewNeedsConfirmationPostedUrl, "https://github.com/ExampleOrg/app-api/pull/1344#issuecomment-1");
  assert.equal(
    issue.metadata["workflow.repos.app_api.pr_auto_review_needs_confirmation_posted_url"],
    "https://github.com/ExampleOrg/app-api/pull/1344#issuecomment-1",
  );
});

test("Work Runtime reconciliation refreshes existing PR metadata when draft state changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/issue-18-test",
          headSha: "def789",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "app-api");
        assert.equal(headRefName, "feature/issue-18-test");
        return [
          {
            repo,
            number: 18,
            title: "ISSUE-18",
            url: "https://github.com/ExampleOrg/app-api/pull/18",
            headRefName,
            isDraft: false,
            mergeable: "CONFLICTING",
            mergeStateStatus: "DIRTY",
            checksPassing: true,
          },
        ];
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-refresh");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-18",
    title: "PR refresh",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/18",
      prIsDraft: true,
      prChecksPassing: false,
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.equal(issue.metadata.prIsDraft, false);
  assert.equal(issue.metadata.prMergeable, "CONFLICTING");
  assert.equal(issue.metadata.prMergeStateStatus, "DIRTY");
  assert.equal(issue.metadata.prChecksPassing, true);
  assert.equal(issue.metadata.prNumber, 18);
});

test("Work Runtime reconciliation completes active undraft worker when GitHub shows PR ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/issue-1407-test",
          headSha: "abc1407",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "app-api");
        assert.equal(headRefName, "feature/issue-1407-test");
        return [
          {
            repo,
            number: 1407,
            title: "ISSUE-15615",
            url: "https://github.com/ExampleOrg/app-api/pull/1407",
            headRefName,
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            checksPassing: true,
          },
        ];
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-undraft-refresh");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15615",
    title: "Tank mix override",
    repoKeys: ["app_api"],
    state: "running",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1407",
      prIsDraft: true,
      "workflow.repos.app_api.branch": "feature/issue-1407-test",
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
    },
  });
  await ledger.recordWorkerRun({
    taskId: "worker-issue-15615-undraft-pr1407",
    issueRef: "ISSUE-15615",
    repoKey: "app_api",
    status: "running",
    summary: "Undraft PR #1407.",
    blockers: [],
    updatedAt: nowIso(),
  });

  const issue = await workRuntime.reconcileIssue(session.id);
  const runs = await ledger.listWorkerRuns("ISSUE-15615");

  assert.equal(issue.metadata.prIsDraft, false);
  assert.equal(runs.at(-1)?.status, "succeeded");
  assert.match(runs.at(-1)?.summary ?? "", /no longer draft/);
});

test("Work Runtime reconciliation refreshes stale recorded PR merge fields from GitHub", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
      async findPullRequests() {
        throw new Error("Recorded PR refresh should use getPullRequest");
      },
      async getPullRequest(repo, number) {
        assert.equal(repo, "app-api");
        assert.equal(number, 1402);
        return {
          repo,
          number,
          title: "ISSUE-15676",
          url: "https://github.com/ExampleOrg/app-api/pull/1402",
          headRefName: "feature/issue-15676-provider-unable-to-process-files-com",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "BLOCKED",
          reviewDecision: "REVIEW_REQUIRED",
          checksPassing: true,
          autoReviewStatus: "pending",
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-stale-recorded");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15676",
    title: "Stale recorded PR",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prRepo: "app-api",
      prNumber: 1402,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1402",
      prMergeable: "",
      prMergeStateStatus: "",
      prReviewDecision: "",
      "workflow.repos.app_api.pr_repo": "app-api",
      "workflow.repos.app_api.pr_number": 1402,
      "workflow.repos.app_api.pr_url": "https://github.com/ExampleOrg/app-api/pull/1402",
    },
  });

  const issue = await workRuntime.refreshReviewState(session.id, "ISSUE-15676");

  assert.equal(issue.metadata.prMergeable, "MERGEABLE");
  assert.equal(issue.metadata.prMergeStateStatus, "BLOCKED");
  assert.equal(issue.metadata.prReviewDecision, "REVIEW_REQUIRED");
  assert.equal(issue.metadata.humanReviewRequired, true);
  assert.equal(issue.metadata.prChecksPassing, true);
  assert.equal(issue.metadata.prAutoReviewStatus, "pending");
});

test("Work Runtime reconciliation lets repo PR snapshot override stale global snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-pr-stale-global");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-20",
    title: "Stale aggregate PR",
    repoKeys: ["public_api"],
    state: "ready_to_run",
    metadata: {
      prRepo: "public-api",
      prNumber: 20,
      prUrl: "https://github.com/ExampleOrg/public-api/pull/20",
      prChecksPassing: false,
      prMergeStateStatus: "BLOCKED",
      "workflow.repos.public_api.pr_repo": "public-api",
      "workflow.repos.public_api.pr_number": 20,
      "workflow.repos.public_api.pr_url": "https://github.com/ExampleOrg/public-api/pull/20",
      "workflow.repos.public_api.pr_checks_passing": true,
      "workflow.repos.public_api.pr_mergeable": "MERGEABLE",
      "workflow.repos.public_api.pr_merge_state_status": "CLEAN",
      "workflow.repos.public_api.pr_review_decision": "APPROVED",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.equal(issue.metadata.prChecksPassing, true);
  assert.equal(issue.metadata.prMergeStateStatus, "CLEAN");
  assert.equal(issue.metadata.prReviewDecision, "APPROVED");
});

test("Work Runtime reconciliation keeps branch-matched PR authoritative over stale global PR", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/ISSUE-15272-test-coverage-ci",
          headSha: "21e22d6e9759a9830564d9fc24e674c50da1b3c9",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "app-api");
        if (headRefName === "feature/ISSUE-15272-test-coverage-ci") {
          return [{
            repo,
            number: 1344,
            title: "feat(ISSUE-15272): add local coverage delta tooling",
            url: "https://github.com/ExampleOrg/app-api/pull/1344",
            headRefName,
            state: "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "BEHIND",
            reviewDecision: "REVIEW_REQUIRED",
            checksPassing: true,
            autoReviewStatus: "passed",
            autoReviewMustFix: false,
            autoReviewNeedsConfirmation: true,
          }];
        }
        return [];
      },
      async getPullRequest(repo, number) {
        assert.equal(repo, "app-api");
        if (number === 1406) {
          return {
            repo,
            number,
            title: "Unrelated stale PR",
            url: "https://github.com/ExampleOrg/app-api/pull/1406",
            headRefName: "bug/ISSUE-15725-panorama-app-key-idempotent",
            state: "MERGED",
            mergedAt: "2026-05-13T10:00:00Z",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: "APPROVED",
            checksPassing: true,
            autoReviewStatus: "passed",
          };
        }
        throw new Error(`Unexpected PR lookup ${number}`);
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-stale-global-current-branch");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15272",
    title: "Coverage PR",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prRepo: "app-api",
      prNumber: 1406,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1406",
      prState: "MERGED",
      prMergedAt: "2026-05-13T10:00:00Z",
      "workflow.repos.app_api.branch": "feature/ISSUE-15272-test-coverage-ci",
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-ISSUE-15272-test-coverage-ci",
      "workflow.repos.app_api.pr_repo": "app-api",
      "workflow.repos.app_api.pr_number": 1344,
      "workflow.repos.app_api.pr_url": "https://github.com/ExampleOrg/app-api/pull/1344",
      "workflow.repos.app_api.pr_auto_review_needs_confirmation_disposition": "accept",
      "workflow.repos.app_api.pr_auto_review_needs_confirmation_posted_url": "https://github.com/ExampleOrg/app-api/pull/1344#issuecomment-4461307698",
    },
  });

  const issue = await workRuntime.refreshReviewState(session.id, "ISSUE-15272");

  assert.equal(issue.metadata.prNumber, 1344);
  assert.equal(issue.metadata.prUrl, "https://github.com/ExampleOrg/app-api/pull/1344");
  assert.equal(issue.metadata.prState, "OPEN");
  assert.equal(issue.metadata.prMergedAt, undefined);
  assert.equal(issue.metadata.prReviewDecision, "REVIEW_REQUIRED");
  assert.equal(issue.metadata.prAutoReviewNeedsConfirmationDisposition, "accept");
  assert.equal(
    issue.metadata.prAutoReviewNeedsConfirmationPostedUrl,
    "https://github.com/ExampleOrg/app-api/pull/1344#issuecomment-4461307698",
  );
});

test("Beads metadata keeps legacy review-ready flag aligned with phase", () => {
  const metadata = workItemToBeadsMetadata({
    ref: "ISSUE-15",
    title: "Review ready",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      "workflow.repos.app_api.head_sha": "abc123",
    },
  });

  assert.equal(metadata["workflow.phase"], "ready_for_review");
  assert.equal(metadata["workflow.ready_for_review"], true);
  assert.equal(metadata["workflow.repos.app_api.head_sha"], "abc123");
});

test("Beads metadata preserves branch kind and Jira issue type for workspace prep", () => {
  const metadata = workItemToBeadsMetadata({
    ref: "ISSUE-15720",
    title: "Partner PartnerCloud Provider Integration",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: {
      branchKind: "feature",
      jiraIssueType: "Story",
    },
  });

  assert.equal(metadata.branchKind, "feature");
  assert.equal(metadata.jiraIssueType, "Story");
});

test("Jira adapter parses issue JSON", () => {
  const issue = parseJiraIssue({
    key: "ISSUE-6",
    fields: {
      summary: "Adapter test",
      issuetype: { name: "Bug" },
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      resolution: { name: "Unresolved" },
      assignee: { displayName: "Camden Lowrance" },
      labels: ["app_api"],
      updated: "2026-05-11T12:00:00.000-0400",
    },
  });

  assert.equal(issue.key, "ISSUE-6");
  assert.equal(issue.summary, "Adapter test");
  assert.equal(issue.issueType, "Bug");
  assert.equal(issue.status, "In Progress");
  assert.equal(issue.statusCategory, "indeterminate");
  assert.equal(issue.resolution, "Unresolved");
});

test("Jira adapter parses comment URL JSON", () => {
  assert.equal(
    parseJiraCommentUrl({ comment: { self: "https://example.atlassian.net/rest/api/3/comment/10001" } }),
    "https://example.atlassian.net/rest/api/3/comment/10001",
  );
});

test("Jira adapter parses workitem search JSON", () => {
  const issues = parseJiraSearch({
    values: [
      {
        key: "ISSUE-7",
        fields: {
          summary: "Search result",
          status: { name: "Ready for Dev" },
          labels: ["public_api"],
        },
      },
    ],
  });

  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, "ISSUE-7");
  assert.equal(issues[0].summary, "Search result");
});

test("Jira adapter queue query includes active dev and review work only", () => {
  assert.equal(
    currentUserOpenSprintJql(configString(legacyHostConfig.issueTracker, "projectKey")),
    "project = ISSUE AND assignee = currentUser() AND sprint in openSprints() AND status in ('Ready for Dev', 'In Progress', 'In Review')",
  );
});

test("Jira adapter backlog query includes default planning statuses", () => {
  assert.equal(
    currentUserBacklogJql(configString(legacyHostConfig.issueTracker, "projectKey")),
    "project = ISSUE AND assignee = currentUser() AND sprint is EMPTY AND status in ('Ready for Dev', 'To Do', 'Selected for Development') ORDER BY updated DESC",
  );
});

test("Beads ledger issue update includes title and description", () => {
  assert.deepEqual(
    beadUpdateArgsForIssue("issue-1", {
      title: "Current Jira title",
      summary: "Current Jira summary",
    }),
    ["update", "issue-1", "--title", "Current Jira title", "--description", "Current Jira summary", "--allow-empty-description"],
  );
});

test("GitHub adapter parses pull request check status", () => {
  const prs = parsePullRequests(
    [
      {
        number: 1,
        title: "PR",
        url: "https://github.com/example/repo/pull/1",
        headRefName: "feature/test",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "REVIEW_REQUIRED",
        body: `### Issue or Reason for Change

ISSUE-1

### Description
- [x] Bug Fix

### Summary of Changes
Changed code.

### Related PRs or Issues
None.`,
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { status: "COMPLETED", conclusion: "NEUTRAL" },
        ],
        reviews: [
          { state: "COMMENTED", author: { login: "khwiri" } },
          { state: "COMMENTED", author: { login: "developer-hla" } },
          { state: "APPROVED", author: { login: "approver" } },
        ],
      },
    ],
    "app-api",
    ["Issue or Reason for Change", "Description", "Summary of Changes", "Related PRs or Issues"],
  );

  assert.equal(prs[0].checksPassing, true);
  assert.equal(prs[0].headRefName, "feature/test");
  assert.equal(prs[0].state, undefined);
  assert.equal(prs[0].mergedAt, undefined);
  assert.equal(prs[0].mergeable, "MERGEABLE");
  assert.equal(prs[0].mergeStateStatus, "CLEAN");
  assert.equal(prs[0].reviewDecision, "REVIEW_REQUIRED");
  assert.equal(prs[0].templateMissingHeadings, undefined);
  assert.equal(prs[0].reviewCommentCount, 2);
  assert.deepEqual(prs[0].reviewCommentAuthors, ["khwiri", "developer-hla"]);
});

test("GitHub issue tracker parses issue list JSON", () => {
  const issues = parseGitHubIssues([
    {
      number: 12,
      title: "Dogfood dashboard with GitHub issues",
      url: "https://github.com/example/flow/issues/12",
      state: "OPEN",
      body: "Use Flow to drive Flow.",
      updatedAt: "2026-05-20T12:00:00Z",
      labels: [{ name: "enhancement" }, { name: "main" }],
      assignees: [{ login: "agent" }],
    },
  ]);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].number, 12);
  assert.equal(issues[0].labels.join(","), "enhancement,main");
  assert.equal(issues[0].assignees.join(","), "agent");
});

test("Provider CLI errors are classified for actionable Flow blockers", () => {
  const missingCli = classifyProviderCliError("github", "gh issue list", {
    message: "spawn gh ENOENT",
    code: "ENOENT",
  });
  const auth = classifyProviderCliError("jira", "acli jira workitem search", {
    stderr: "Unauthorized: token expired",
  });
  const rateLimit = classifyProviderCliError("github", "gh pr view", {
    stderr: "API rate limit exceeded",
  });

  assert.ok(missingCli instanceof ProviderAdapterError);
  assert.equal(missingCli.code, "cli_missing");
  assert.equal(auth.code, "auth_missing");
  assert.equal(rateLimit.code, "rate_limited");
});

test("GitHub adapter parses merged pull request lifecycle fields", () => {
  const prs = parsePullRequests(
    [
      {
        number: 1393,
        title: "ISSUE-15594",
        url: "https://github.com/ExampleOrg/app-api/pull/1393",
        headRefName: "feature/issue-15594",
        state: "MERGED",
        mergedAt: "2026-05-11T19:11:01Z",
        isDraft: false,
        body: `### Issue or Reason for Change

ISSUE-15594

### Description
- [x] Bug Fix

### Summary of Changes
Changed code.

### Related PRs or Issues
None.`,
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
      },
    ],
    "app-api",
    ["Issue or Reason for Change", "Description", "Summary of Changes", "Related PRs or Issues"],
  );

  assert.equal(prs[0].state, "MERGED");
  assert.equal(prs[0].mergedAt, "2026-05-11T19:11:01Z");
});

test("GitHub adapter flags pull requests missing template headings", () => {
  const prs = parsePullRequests(
    [
      {
        number: 1402,
        title: "ISSUE-15676",
        url: "https://github.com/ExampleOrg/app-api/pull/1402",
        headRefName: "feature/issue-15676",
        isDraft: false,
        body: `## Summary
- Harden Provider batch handling.

## Validation
- pytest`,
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
    ],
    "app-api",
    ["Issue or Reason for Change", "Description", "Summary of Changes", "Related PRs or Issues"],
  );

  assert.deepEqual(prs[0].templateMissingHeadings, [
    "Issue or Reason for Change",
    "Description",
    "Summary of Changes",
    "Related PRs or Issues",
  ]);
});

test("GitHub adapter does not enforce a PR template when none is provided", () => {
  const prs = parsePullRequests(
    [
      {
        number: 1403,
        title: "ISSUE-15677",
        url: "https://github.com/ExampleOrg/app-api/pull/1403",
        headRefName: "feature/issue-15677",
        isDraft: false,
        body: "No repository template is configured.",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
    ],
    "app-api",
  );

  assert.equal(prs[0].templateMissingHeadings, undefined);
});

test("GitHub adapter parses auto review must-fix sections", () => {
  const feedback = extractAutoReviewFeedback(`<!-- flow-pr-review -->
## Summary
- Tests were added.

## Must-fix
- New test files use \`// @ts-nocheck\`, which hides type errors.

## Needs Confirmation
None.

## Suggestions
- Prefer typed mocks.`);

  assert.equal(feedback.mustFix, true);
  assert.match(feedback.mustFixDetail ?? "", /ts-nocheck/);
  assert.equal(feedback.needsConfirmation, false);
});

test("GitHub adapter treats empty auto review sections as no feedback", () => {
  const feedback = extractAutoReviewFeedback(`<!-- flow-pr-review -->
## Summary
No issues found.

## Must-fix
None found.

## Needs Confirmation
None identified.`);

  assert.equal(feedback.mustFix, false);
  assert.equal(feedback.mustFixDetail, undefined);
  assert.equal(feedback.needsConfirmation, false);
  assert.equal(feedback.needsConfirmationDetail, undefined);
});

test("Custom topology overrides repo names, paths, branch names, and PR URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-topo-"));
  await mkdir(join(root, "my-service"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();

  const customTopology: ProjectTopology = {
    validRepoKeys: new Set(["my_service", "my_ui"]),
    isValidRepoKey(repoKey) {
      return this.validRepoKeys.has(repoKey.replace(/-/g, "_"));
    },
    inferRepoKeysFromIssue(issue) {
      const text = `${issue.title} ${issue.labels.join(" ")}`.toLowerCase();
      if (text.includes("frontend")) return ["my_ui"];
      if (text.includes("backend")) return ["my_service"];
      return [];
    },
    branchName(issue) {
      return `work/${issue.ref}`;
    },
    defaultBaseBranch() {
      return "main";
    },
    repoName(repoKey) {
      return repoKey.replace(/_/g, "-");
    },
    repoPath(projectRoot, repoKey) {
      return join(projectRoot, repoKey.replace(/_/g, "-"));
    },
    pullRequestUrl(repo, number) {
      return `https://gitlab.example.com/${repo}/-/merge_requests/${number}`;
    },
  };

  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    topology: customTopology,
    projectRoot: root,
    issueTracker: {
      capabilities: {
        canCreateIssues: false,
        canTransitionIssues: false,
        canPostComments: false,
        canManageActivePlanningLane: false,
      },
      async getIssue(ref) {
        return {
          ref,
          title: "Fix backend crash",
          status: "Open",
          type: "bug",
          url: `https://tracker.example/${ref}`,
          labels: ["backend"],
        };
      },
      async fetchActiveQueue() {
        return [
          {
            ref: "PROJ-42",
            title: "Fix backend crash",
            status: "Open",
            type: "bug",
            url: "https://tracker.example/PROJ-42",
            labels: ["backend"],
          },
        ];
      },
    },
  });

  assert.equal(workRuntime.topology, customTopology);

  const queue = await workRuntime.inspectQueue(10);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].ref, "PROJ-42");
  assert.deepEqual(queue[0].repoKeys, ["my_service"]);

  assert.equal(customTopology.repoName("my_service"), "my-service");
  assert.equal(customTopology.repoPath(root, "my_service"), join(root, "my-service"));
  assert.equal(customTopology.branchName(queue[0]), "work/PROJ-42");
  assert.equal(customTopology.defaultBaseBranch("my_service"), "main");
  assert.equal(customTopology.pullRequestUrl("my-service", 7), "https://gitlab.example.com/my-service/-/merge_requests/7");

  assert.equal(customTopology.isValidRepoKey("my_service"), true);
  assert.equal(customTopology.isValidRepoKey("unknown_repo"), false);
});
