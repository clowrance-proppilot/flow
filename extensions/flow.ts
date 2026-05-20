import { join } from "node:path";
import { Type } from "typebox";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FlowWorkRuntime, FlowStore, createDefaultWorkerSpawner, createWorkflowLedger } from "../src/index.js";
import { GhGitHubAdapter } from "../src/adapters/github.js";
import { AcliJiraAdapter } from "../src/adapters/jira.js";

function flowRoot() {
  return process.env.FLOW_ROOT ?? process.cwd();
}

function workRuntime() {
  const repoRoot = flowRoot();
  const root = join(repoRoot, ".context", "flow", "flow-runtime");
  // TODO(flow-contracts): Route tool response payloads through a dedicated
  // contract adapter layer so external shapes are decoupled from workRuntime internals.
  return new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger: createWorkflowLedger({ cwd: repoRoot }),
    github: new GhGitHubAdapter({ cwd: repoRoot }),
    jira: new AcliJiraAdapter({ cwd: repoRoot }),
    projectRoot: repoRoot,
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("flow", ctx.ui.theme.fg("success", "Flow"));
  });

  pi.registerCommand("flow", {
    description: "Ask Flow for queue, next issue, advance, or autoflow help.",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Flow command queued after the current turn finishes.", "info");
      }

      pi.sendUserMessage(flowCommandPrompt(args), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    },
  });

  pi.registerTool({
    name: "flow_inspect_queue",
    label: "Flow Queue",
    description: "Inspect Jira-eligible Flow work through the Work Runtime.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      const issues = await workRuntime().inspectQueue(params.limit ?? 10);
      const text = issues.map((issue) => {
        const repos = issue.repoKeys.length ? issue.repoKeys.join(", ") : "unrouted";
        return `${issue.ref}: ${issue.title} (repo_keys: ${repos})`;
      }).join("\n") || "No issues found.";
      return { content: [{ type: "text", text }], details: { issues } };
    },
  });

  pi.registerTool({
    name: "flow_inspect_backlog",
    label: "Flow Backlog",
    description: "Inspect current-user Jira backlog work that is not in an active sprint.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      const issues = await workRuntime().inspectBacklog(params.limit ?? 10);
      const text = issues.map((issue) => {
        const repos = issue.repoKeys.length ? issue.repoKeys.join(", ") : "unrouted";
        return `${issue.ref}: ${issue.title} (repo_keys: ${repos})`;
      }).join("\n") || "No backlog issues found.";
      return { content: [{ type: "text", text }], details: { issues } };
    },
  });

  pi.registerTool({
    name: "flow_create_session",
    label: "Flow Session",
    description: "Create an Flow Work Runtime session.",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      const session = await workRuntime().createSession(params.id);
      return { content: [{ type: "text", text: `Created session ${session.id}` }], details: session };
    },
  });

  pi.registerTool({
    name: "flow_select_issue",
    label: "Flow Select Issue",
    description: "Select an issue in a Work Runtime session.",
    parameters: Type.Object({
      sessionId: Type.String(),
      ref: Type.String(),
      title: Type.String(),
      repoKeys: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params) {
      const session = await workRuntime().selectIssue(params.sessionId, {
        ref: params.ref,
        title: params.title,
        repoKeys: params.repoKeys ?? [],
        state: "queued",
        metadata: {},
      });
      return { content: [{ type: "text", text: `Selected ${params.ref}` }], details: session };
    },
  });

  pi.registerTool({
    name: "flow_bootstrap_jira_issue",
    label: "Flow Bootstrap Jira",
    description: "Create or adopt Flow ledger state for an existing Jira issue, then optionally select it.",
    parameters: Type.Object({
      sessionId: Type.String(),
      issueRef: Type.String(),
      repoKeys: Type.Optional(Type.Array(Type.String())),
      branch: Type.Optional(Type.String()),
      branchKind: Type.Optional(Type.Union([Type.Literal("bug"), Type.Literal("feature")])),
      worktreePath: Type.Optional(Type.String()),
      baseBranch: Type.Optional(Type.String()),
      select: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      const issue = await workRuntime().bootstrapJiraIssue(params.sessionId, params.issueRef, {
        repoKeys: params.repoKeys,
        branch: params.branch,
        branchKind: params.branchKind,
        worktreePath: params.worktreePath,
        baseBranch: params.baseBranch,
        select: params.select,
      });
      const repos = issue.repoKeys.length ? issue.repoKeys.join(", ") : "unrouted";
      return {
        content: [{ type: "text", text: `Bootstrapped ${issue.ref} from Jira (repo_keys: ${repos})\n${formatIssueProjection(issue)}` }],
        details: { issue },
      };
    },
  });

  pi.registerTool({
    name: "flow_create_jira_issue",
    label: "Flow Create Jira",
    description: "Create a new Jira issue through Work Runtime, then optionally select it.",
    parameters: Type.Object({
      sessionId: Type.String(),
      summary: Type.String(),
      description: Type.Optional(Type.String()),
      issueType: Type.Optional(Type.Union([Type.Literal("Bug"), Type.Literal("Task"), Type.Literal("Story")])),
      branchKind: Type.Optional(Type.Union([Type.Literal("bug"), Type.Literal("feature")])),
      repoKeys: Type.Optional(Type.Array(Type.String())),
      select: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      const issue = await workRuntime().createJiraIssue(params.sessionId, {
        summary: params.summary,
        description: params.description,
        issueType: params.issueType,
        branchKind: params.branchKind,
        repoKeys: params.repoKeys,
        select: params.select,
      });
      return {
        content: [{ type: "text", text: `Created Jira ${issue.ref}\n${formatIssueProjection(issue)}` }],
        details: { issue },
      };
    },
  });

  pi.registerTool({
    name: "flow_move_issues_to_active_sprint",
    label: "Flow Move To Sprint",
    description: "Move Jira issues into the current active sprint through Work Runtime.",
    parameters: Type.Object({
      sessionId: Type.String(),
      issueRefs: Type.Array(Type.String()),
      projectKey: Type.Optional(Type.String()),
      boardId: Type.Optional(Type.Number()),
      sprintId: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      const moved = await workRuntime().moveIssuesToActiveSprint(params.sessionId, params.issueRefs, {
        projectKey: params.projectKey,
        boardId: params.boardId,
        sprintId: params.sprintId,
      });
      return {
        content: [{
          type: "text",
          text: `Moved ${moved.issueKeys.join(", ")} to sprint ${moved.sprintName ?? moved.sprintId}`,
        }],
        details: moved,
      };
    },
  });

  pi.registerTool({
    name: "flow_route_issue",
    label: "Flow Route Issue",
    description: "Record Work Runtime-approved repo routing for an issue in the workflow ledger.",
    parameters: Type.Object({
      sessionId: Type.String(),
      issueRef: Type.String(),
      repoKeys: Type.Array(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const issue = await workRuntime().routeIssue(params.sessionId, params.issueRef, params.repoKeys);
      return {
        content: [{ type: "text", text: `Routed ${params.issueRef} to ${issue.repoKeys.join(", ")}\n${formatIssueProjection(issue)}` }],
        details: { issue },
      };
    },
  });

  pi.registerTool({
    name: "flow_prepare_workspace",
    label: "Flow Prepare Workspace",
    description: "Prepare a repo-local git worktree through Work Runtime and record it in the workflow ledger.",
    parameters: Type.Object({
      sessionId: Type.String(),
      issueRef: Type.String(),
      repoKey: Type.Optional(Type.String()),
      baseBranch: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const issue = await workRuntime().prepareWorkspace(params.sessionId, params.issueRef, {
        repoKey: params.repoKey,
        baseBranch: params.baseBranch,
      });
      const selectedRepoKey = params.repoKey ?? issue.repoKeys[0] ?? "";
      const branch = typeof issue.metadata[`workflow.repos.${selectedRepoKey}.branch`] === "string"
        ? issue.metadata[`workflow.repos.${selectedRepoKey}.branch`]
        : issue.metadata.branch;
      const workDir = typeof issue.metadata[`workflow.repos.${selectedRepoKey}.worktree_path`] === "string"
        ? issue.metadata[`workflow.repos.${selectedRepoKey}.worktree_path`]
        : issue.metadata.work_dir;
      return {
        content: [{
          type: "text",
          text: `Prepared workspace for ${params.issueRef}; branch=${String(branch ?? "")}; work_dir=${String(workDir ?? "")}\n${formatIssueProjection(issue)}`,
        }],
        details: { issue, branch, workDir, repoKey: selectedRepoKey },
      };
    },
  });

  pi.registerTool({
    name: "flow_advance_issue",
    label: "Flow Advance Issue",
    description: "Reconcile, consult Readiness, and advance the selected issue.",
    parameters: Type.Object({
      sessionId: Type.String(),
      approveConfirmationId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const result = await workRuntime().advanceIssue(params.sessionId, params.approveConfirmationId);
      const issueProjection = result.issue ? `\n${formatIssueProjection(result.issue)}` : "";
      return { content: [{ type: "text", text: `${result.message}${issueProjection}` }], details: result };
    },
  });

  pi.registerTool({
    name: "flow_handoff_summary",
    label: "Flow Handoff",
    description: "Summarize current Flow Work Runtime session state.",
    parameters: Type.Object({ sessionId: Type.String() }),
    async execute(_toolCallId, params) {
      const summary = await workRuntime().summarizeHandoff(params.sessionId);
      return { content: [{ type: "text", text: summary }], details: { summary } };
    },
  });

  pi.registerTool({
    name: "flow_record_evidence",
    label: "Flow Evidence",
    description: "Record acceptance evidence for an issue through the Work Runtime.",
    parameters: Type.Object({
      sessionId: Type.String(),
      issueRef: Type.String(),
      summary: Type.String(),
      source: Type.String(),
      criteria: Type.Optional(Type.Array(Type.Object({
        label: Type.String(),
        status: Type.Optional(Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_applicable")])),
        evidence: Type.String(),
        source: Type.Optional(Type.String()),
      }))),
    }),
    async execute(_toolCallId, params) {
      const issue = await workRuntime().recordEvidence(params.sessionId, {
        issueRef: params.issueRef,
        summary: params.summary,
        source: params.source,
        criteria: params.criteria ?? [],
      });
      return { content: [{ type: "text", text: `Recorded evidence for ${params.issueRef}\n${formatIssueProjection(issue)}` }], details: { issue } };
    },
  });

  pi.registerTool({
    name: "flow_record_acceptance_writeback",
    label: "Flow Acceptance Writeback",
    description: "Write recorded acceptance evidence to Jira through the Work Runtime.",
    parameters: Type.Object({
      sessionId: Type.String(),
      issueRef: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const issue = await workRuntime().recordAcceptanceWriteback(params.sessionId, params.issueRef);
      return {
        content: [{ type: "text", text: `Recorded acceptance evidence in Jira for ${issue.ref}\n${formatIssueProjection(issue)}` }],
        details: { issue },
      };
    },
  });

  pi.registerTool({
    name: "flow_closeout_after_approval",
    label: "Flow Closeout",
    description: "After approval, record acceptance evidence, merge the PR, and verify Jira moved by automation.",
    parameters: Type.Object({
      sessionId: Type.String(),
      issueRef: Type.Optional(Type.String()),
      mergeMethod: Type.Optional(Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")])),
      jiraPollAttempts: Type.Optional(Type.Number()),
      jiraPollIntervalMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      const result = await workRuntime().closeoutAfterApproval(params.sessionId, {
        issueRef: params.issueRef,
        mergeMethod: params.mergeMethod,
        jiraPollAttempts: params.jiraPollAttempts,
        jiraPollIntervalMs: params.jiraPollIntervalMs,
      });
      return {
        content: [{ type: "text", text: `Closeout ${result.status} for ${result.issue.ref}\n${formatIssueProjection(result.issue)}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "flow_record_review_confirmation",
    label: "Flow Review Confirmation",
    description: "Record an auto-review needs-confirmation disposition and post the confirmation to the GitHub PR through the Work Runtime.",
    parameters: Type.Object({
      sessionId: Type.String(),
      issueRef: Type.String(),
      repo: Type.String(),
      number: Type.Number(),
      disposition: Type.Union([Type.Literal("accept"), Type.Literal("reject"), Type.Literal("defer")]),
      summary: Type.String(),
      evidence: Type.Optional(Type.String()),
      verification: Type.Optional(Type.String()),
      githubCommentUrl: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const issue = await workRuntime().recordReviewConfirmation(params.sessionId, params);
      return {
        content: [{ type: "text", text: `Recorded review confirmation for ${params.issueRef}\n${formatIssueProjection(issue)}` }],
        details: { issue },
      };
    },
  });

  pi.registerTool({
    name: "flow_record_documentation",
    label: "Flow Docs",
    description: "Record documentation disposition for an issue through the Work Runtime.",
    parameters: Type.Object({
      sessionId: Type.String(),
      issueRef: Type.String(),
      disposition: Type.Union([Type.Literal("not_needed"), Type.Literal("updated"), Type.Literal("needed")]),
      summary: Type.String(),
    }),
    async execute(_toolCallId, params) {
      const issue = await workRuntime().recordDocumentation(params.sessionId, {
        issueRef: params.issueRef,
        disposition: params.disposition,
        summary: params.summary,
      });
      return {
        content: [{ type: "text", text: `Recorded documentation disposition for ${params.issueRef}\n${formatIssueProjection(issue)}` }],
        details: { issue },
      };
    },
  });

  pi.registerTool({
    name: "flow_record_provider_escalation",
    label: "Flow Provider Escalation",
    description: "Record that an issue is blocked on a third-party provider instead of a code change.",
    parameters: Type.Object({
      sessionId: Type.String(),
      issueRef: Type.String(),
      provider: Type.String(),
      summary: Type.String(),
      blocker: Type.String(),
      supportUrl: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const issue = await workRuntime().recordProviderEscalation(params.sessionId, params);
      return {
        content: [{ type: "text", text: `Recorded provider escalation for ${params.issueRef}\n${formatIssueProjection(issue)}` }],
        details: { issue },
      };
    },
  });

  pi.registerTool({
    name: "flow_record_pull_request",
    label: "Flow PR",
    description: "Record pull request handoff metadata for an issue through the Work Runtime.",
    parameters: Type.Object({
      sessionId: Type.String(),
      issueRef: Type.String(),
      repo: Type.String(),
      number: Type.Number(),
      url: Type.String(),
      isDraft: Type.Boolean(),
      checksPassing: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      const issue = await workRuntime().recordPullRequest(params.sessionId, params);
      return { content: [{ type: "text", text: `Recorded PR for ${params.issueRef}\n${formatIssueProjection(issue)}` }], details: { issue } };
    },
  });

  pi.registerTool({
    name: "flow_observe_executors",
    label: "Flow Observe Executors",
    description: "Inspect Work Runtime-recorded executor lifecycle state from the configured ledger.",
    parameters: Type.Object({
      sessionId: Type.String(),
      issueRef: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const runs = await workRuntime().observeExecutors(params.sessionId, params.issueRef);
      const text = runs.length
        ? runs.map((run) => `${run.taskId}: ${run.status}${run.summary ? ` - ${run.summary}` : ""}`).join("\n")
        : "No executor runs recorded.";
      return { content: [{ type: "text", text }], details: { runs } };
    },
  });

  pi.registerTool({
    name: "flow_list_work_jobs",
    label: "Flow Work Jobs",
    description: "Inspect Work Runtime-recorded typed work jobs for debugging.",
    parameters: Type.Object({
      sessionId: Type.String(),
      issueRef: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const jobs = await workRuntime().listWorkJobs(params.sessionId, params.issueRef);
      const text = jobs.length
        ? jobs.map((job) => `${job.id}: ${job.workType} ${job.status} in ${job.repoKey}`).join("\n")
        : "No typed work jobs recorded.";
      return { content: [{ type: "text", text }], details: { jobs } };
    },
  });

  pi.registerTool({
    name: "flow_submit_work",
    label: "Flow Submit Work",
    description: "Submit a YAML frontmatter plus Markdown work envelope to the Work Runtime.",
    parameters: Type.Object({
      sessionId: Type.String(),
      envelope: Type.String(),
    }),
    async execute(_toolCallId, params) {
      const job = await workRuntime().submitWorkEnvelope(params.sessionId, params.envelope);
      return {
        content: [{ type: "text", text: `Submitted ${job.workType} job ${job.id} for ${job.issueRef}.` }],
        details: { job },
      };
    },
  });

  pi.registerTool({
    name: "flow_record_executor_progress",
    label: "Flow Executor Progress",
    description: "Record executor-scoped progress without mutating issue phase.",
    parameters: Type.Object({
      taskId: Type.String(),
      issueRef: Type.String(),
      repoKey: Type.String(),
      executor: Type.Optional(Type.Union([
        Type.Literal("pi"),
        Type.Literal("live_agent_thread"),
      ])),
      status: Type.Union([
        Type.Literal("queued"),
        Type.Literal("running"),
        Type.Literal("succeeded"),
        Type.Literal("blocked"),
        Type.Literal("failed"),
      ]),
      summary: Type.Optional(Type.String()),
      workspacePath: Type.Optional(Type.String()),
      blockers: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params) {
      const updatedAt = new Date().toISOString();
      const run = {
        taskId: params.taskId,
        issueRef: params.issueRef,
        repoKey: params.repoKey,
        executor: params.executor,
        status: params.status,
        summary: params.summary,
        workspacePath: params.workspacePath,
        blockers: params.blockers ?? [],
        startedAt: params.status === "running" ? updatedAt : undefined,
        completedAt: ["succeeded", "blocked", "failed"].includes(params.status) ? updatedAt : undefined,
        updatedAt,
      };
      await createWorkflowLedger({ cwd: flowRoot() }).recordWorkerRun(run);
      return {
        content: [{ type: "text", text: `Recorded ${params.status} progress for ${params.taskId}` }],
        details: { run },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "flow_adopt_local_thread",
    label: "Flow Local Thread",
    description: "Adopt a Work Runtime-created execution request into the current local agent thread.",
    parameters: Type.Object({
      sessionId: Type.String(),
      id: Type.String(),
      issueRef: Type.String(),
      repoKey: Type.String(),
      workJobId: Type.Optional(Type.String()),
      prompt: Type.String(),
      workspacePath: Type.String(),
      createdAt: Type.String(),
      adopter: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const request = await workRuntime().adoptLocalThread(
        params.sessionId,
        {
          id: params.id,
          issueRef: params.issueRef,
          repoKey: params.repoKey,
          workJobId: params.workJobId,
          executor: "live_agent_thread",
          prompt: params.prompt,
          workspacePath: params.workspacePath,
          createdAt: params.createdAt,
        },
        { adopter: params.adopter, summary: params.summary },
      );
      return {
        content: [{
          type: "text",
          text: `Live agent thread adopted ${params.id} for ${params.issueRef} in ${params.repoKey}`,
        }],
        details: { request },
      };
    },
  });

  pi.registerTool({
    name: "flow_adopt_pending_local_thread",
    label: "Flow Adopt Pending Local Thread",
    description: "Create or approve the current Work Runtime execution request, then adopt it into the current local agent thread.",
    parameters: Type.Object({
      sessionId: Type.String(),
      adopter: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const request = await workRuntime().adoptPendingLocalThread(
        params.sessionId,
        { adopter: params.adopter, summary: params.summary },
      );
      return {
        content: [{
          type: "text",
          text: `Live agent thread adopted pending executor ${request.id} for ${request.issueRef} in ${request.repoKey}`,
        }],
        details: { request },
      };
    },
  });

  pi.registerTool({
    name: "flow_record_executor_result",
    label: "Flow Executor Result",
    description: "Record the structured closeout result for a local-thread or background executor.",
    parameters: Type.Object({
      sessionId: Type.String(),
      taskId: Type.String(),
      issueRef: Type.String(),
      repoKey: Type.String(),
      workJobId: Type.Optional(Type.String()),
      executor: Type.Optional(Type.Union([
        Type.Literal("pi"),
        Type.Literal("live_agent_thread"),
      ])),
      status: Type.Union([
        Type.Literal("succeeded"),
        Type.Literal("blocked"),
        Type.Literal("failed"),
      ]),
      summary: Type.String(),
      changedFiles: Type.Optional(Type.Array(Type.String())),
      testsRun: Type.Optional(Type.Array(Type.String())),
      blockers: Type.Optional(Type.Array(Type.String())),
      nextPickup: Type.Optional(Type.String()),
      handoffPrompt: Type.Optional(Type.String()),
      evidenceCandidate: Type.Optional(Type.String()),
      completedAt: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const session = await workRuntime().recordExecutorResult(params.sessionId, {
        taskId: params.taskId,
        issueRef: params.issueRef,
        repoKey: params.repoKey,
        workJobId: params.workJobId,
        executor: params.executor,
        status: params.status,
        summary: params.summary,
        changedFiles: params.changedFiles ?? [],
        testsRun: params.testsRun ?? [],
        blockers: params.blockers ?? [],
        nextPickup: params.nextPickup,
        handoffPrompt: params.handoffPrompt,
        evidenceCandidate: params.evidenceCandidate,
        completedAt: params.completedAt ?? new Date().toISOString(),
      });
      return {
        content: [{ type: "text", text: `Recorded ${params.status} executor result for ${params.taskId}` }],
        details: { session },
      };
    },
  });

  pi.registerTool({
    name: "flow_run_background_executor",
    label: "Flow Run Background Executor",
    description: "Run a background executor request and record the result in the workflow ledger.",
    parameters: Type.Object({
      sessionId: Type.String(),
      id: Type.String(),
      issueRef: Type.String(),
      repoKey: Type.String(),
      executor: Type.Optional(Type.Union([
        Type.Literal("pi"),
        Type.Literal("live_agent_thread"),
      ])),
      prompt: Type.String(),
      workspacePath: Type.Optional(Type.String()),
      createdAt: Type.String(),
    }),
    async execute(_toolCallId, params) {
      const result = await workRuntime().runBackgroundExecutor(
        params.sessionId,
        {
          id: params.id,
          issueRef: params.issueRef,
          repoKey: params.repoKey,
          executor: params.executor,
          prompt: params.prompt,
          workspacePath: params.workspacePath,
          createdAt: params.createdAt,
        },
        createDefaultWorkerSpawner({ flowRoot: flowRoot() }),
      );
      return { content: [{ type: "text", text: result.summary }], details: result };
    },
  });

  pi.registerTool({
    name: "flow_autoflow_issue",
    label: "Flow Autoflow",
    description: "Advance a selected issue until it needs human input, is blocked, or reaches review-ready.",
    parameters: Type.Object({
      sessionId: Type.String(),
      autoPrepareWorkspace: Type.Optional(Type.Boolean()),
      autoApproveWorker: Type.Optional(Type.Boolean()),
      runBackgroundExecutor: Type.Optional(Type.Boolean()),
      maxSteps: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      const result = await workRuntime().autoFlowIssue(
        params.sessionId,
        createDefaultWorkerSpawner({ flowRoot: flowRoot() }),
        {
          autoPrepareWorkspace: params.autoPrepareWorkspace ?? true,
          autoApproveWorker: params.autoApproveWorker ?? true,
          runWorker: params.runBackgroundExecutor ?? true,
          maxSteps: params.maxSteps,
        },
      );
      return {
        content: [{ type: "text", text: `${result.message}${result.issue ? `\n${formatIssueProjection(result.issue)}` : ""}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "flow_reset_autoflow_state",
    label: "Flow Reset Autoflow",
    description: "Reset Autoflow attempt state for selected workflow issues so Flow can retry after fixes or operator approval.",
    parameters: Type.Object({
      sessionId: Type.String(),
      issueRefs: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params) {
      const issues = await workRuntime().resetAutoflowState(params.sessionId, params.issueRefs);
      return {
        content: [{ type: "text", text: `Reset Autoflow state for ${issues.map((issue) => issue.ref).join(", ")}` }],
        details: { issues },
      };
    },
  });
}

function formatIssueProjection(issue: unknown): string {
  if (!isIssueRecord(issue)) return "issue projection unavailable";
  const metadata = isRecord(issue.metadata) ? issue.metadata : {};
  const repoKeys = Array.isArray(issue.repoKeys) ? issue.repoKeys.map(String).filter(Boolean) : [];
  const repoValues = repoKeys.map((repoKey) => repoProjection(metadata, repoKey));
  const firstRepo = repoValues.find((repo) => repo.prUrl || repo.worktreePath || repo.branch);
  const prNumber = stringValue(metadata.prNumber) ?? firstRepo?.prNumber;
  const prUrl = stringValue(metadata.prUrl) ?? firstRepo?.prUrl;
  const confirmationDisposition = stringValue(metadata.prAutoReviewNeedsConfirmationDisposition) ??
    firstRepo?.confirmationDisposition;
  const confirmationPostedUrl = stringValue(metadata.prAutoReviewNeedsConfirmationPostedUrl) ??
    firstRepo?.confirmationPostedUrl;
  const lines = [
    `issue_state: ${stringValue(issue.state) ?? ""}`,
    `repo_keys: ${repoKeys.join(", ") || "unrouted"}`,
    `prepared_worktree: ${firstValue([firstRepo?.worktreePath, stringValue(metadata.work_dir), stringValue(metadata.worktree_path)]) ?? ""}`,
    `branch: ${firstValue([firstRepo?.branch, stringValue(metadata.branch)]) ?? ""}`,
    `pr_number: ${prNumber ?? ""}`,
    `pr_url: ${prUrl ?? ""}`,
    `pr_checks_passing: ${stringValue(metadata.prChecksPassing) ?? firstRepo?.checksPassing ?? ""}`,
    `pr_review_decision: ${stringValue(metadata.prReviewDecision) ?? firstRepo?.reviewDecision ?? ""}`,
    `auto_review_status: ${stringValue(metadata.prAutoReviewStatus) ?? firstRepo?.autoReviewStatus ?? ""}`,
    `auto_review_confirmation_disposition: ${confirmationDisposition ?? ""}`,
    `auto_review_confirmation_posted_url: ${confirmationPostedUrl ?? ""}`,
    `evidence_recorded: ${stringValue(metadata.evidenceRecorded) ?? stringValue(metadata["workflow.acceptance.status"]) ?? ""}`,
    `documentation_recorded: ${stringValue(metadata.documentationRecorded) ?? stringValue(metadata.documentationDisposition) ?? ""}`,
    `jira_status: ${stringValue(metadata.jiraStatus) ?? ""}`,
  ];
  return lines.join("\n");
}

function repoProjection(metadata: Record<string, unknown>, repoKey: string) {
  const prefix = `workflow.repos.${repoKey}.`;
  const prPrefix = `${prefix}pr_`;
  return {
    branch: stringValue(metadata[`${prefix}branch`]),
    worktreePath: stringValue(metadata[`${prefix}worktree_path`]),
    prNumber: stringValue(metadata[`${prPrefix}number`]),
    prUrl: stringValue(metadata[`${prPrefix}url`]),
    checksPassing: stringValue(metadata[`${prPrefix}checks_passing`]),
    reviewDecision: stringValue(metadata[`${prPrefix}review_decision`]),
    autoReviewStatus: stringValue(metadata[`${prPrefix}auto_review_status`]),
    confirmationDisposition: stringValue(metadata[`${prPrefix}auto_review_needs_confirmation_disposition`]),
    confirmationPostedUrl: stringValue(metadata[`${prPrefix}auto_review_needs_confirmation_posted_url`]),
  };
}

function firstValue(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value !== "" && value !== "undefined");
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function isIssueRecord(value: unknown): value is { state?: unknown; repoKeys?: unknown; metadata?: unknown } {
  return isRecord(value) && isRecord(value.metadata);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flowCommandPrompt(args: string): string {
  const trimmed = args.trim();
  const [command, ...rest] = trimmed.split(/\s+/).filter(Boolean);
  const target = rest.join(" ");

  switch (command) {
    case undefined:
    case "":
    case "status":
      return "Create or reuse an Flow Work Runtime session, inspect the queue, and summarize what needs attention.";
    case "queue":
      return "Create or reuse an Flow Work Runtime session and inspect the Flow queue.";
    case "next":
      return "Create or reuse an Flow Work Runtime session, inspect the Flow queue, and recommend the best next issue to advance.";
    case "select":
      return target
        ? `Create or reuse an Flow Work Runtime session, inspect ${target}, select it, and explain its current blocker.`
        : "Ask me which issue key to select.";
    case "route":
      return target
        ? `Create or reuse an Flow Work Runtime session and route this Flow issue as requested: ${target}. Then reconcile and report the next valid action.`
        : "Ask me which issue key and repo keys to route.";
    case "prepare":
      return target
        ? `Create or reuse an Flow Work Runtime session and prepare a workspace as requested: ${target}. Then reconcile and report the next valid action.`
        : "Ask me which issue key and repo key to prepare.";
    case "advance":
      return target
        ? `Create or reuse an Flow Work Runtime session, select ${target}, reconcile it, and advance it until confirmation, blocker, worker request, or review-ready.`
        : "Advance the currently selected Flow issue until confirmation, blocker, worker request, or review-ready.";
    case "autoflow":
      return target
        ? `Create or reuse an Flow Work Runtime session, select ${target}, then run Flow autoflow. Prepare routed workspaces automatically, approve Worker confirmation, run the Worker, and stop at blocker, review-ready, done, or human input required. Report the exact state.`
        : "Run Flow autoflow on the currently selected issue. Prepare routed workspaces automatically, approve Worker confirmation, run the Worker, and stop at blocker, review-ready, done, or human input required. Report the exact state.";
    case "help":
    default:
      return [
        "Explain the Flow commands briefly.",
        "Mention: /flow queue, /flow next, /flow select ISSUE-123, /flow advance ISSUE-123, /flow autoflow ISSUE-123.",
      ].join("\n");
  }
}
