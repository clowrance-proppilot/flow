import type { ProjectedWorkSubject } from "../core/work-projection.js";

export interface WorkStatePolicyResult {
  accepted: boolean;
  blockers: string[];
}

export interface CompleteWorkPolicyInput {
  projection: ProjectedWorkSubject;
  codeProducing?: boolean;
  readinessPassed?: boolean;
}

export function canCompleteWork(input: CompleteWorkPolicyInput): WorkStatePolicyResult {
  const blockers: string[] = [];
  const unresolved = input.projection.blockers.filter((blocker) => !blocker.resolvedByEventId);
  if (unresolved.length) blockers.push("Unresolved blockers remain.");
  if (input.codeProducing && !input.projection.links.some((link) => link.target.type === "pull_request")) {
    blockers.push("Code-producing work requires a linked pull request.");
  }
  if (input.readinessPassed === false) blockers.push("Readiness checks have not passed.");
  return { accepted: blockers.length === 0, blockers };
}

export function canClaimWork(projection: ProjectedWorkSubject, options: { allowParallelClaims?: boolean } = {}): WorkStatePolicyResult {
  if (options.allowParallelClaims) return { accepted: true, blockers: [] };
  if (projection.completedAt) return { accepted: false, blockers: ["Work is already complete."] };
  if (projection.claims.length > 0 && projection.state !== "done") {
    return { accepted: false, blockers: ["An active claim already exists."] };
  }
  return { accepted: true, blockers: [] };
}

export function canResolveBlocker(projection: ProjectedWorkSubject, askEventId: string): WorkStatePolicyResult {
  const blocker = projection.blockers.find((candidate) => candidate.eventId === askEventId);
  if (!blocker) return { accepted: false, blockers: [`No blocker exists for ask event ${askEventId}.`] };
  if (blocker.resolvedByEventId) return { accepted: false, blockers: [`Blocker ${askEventId} is already resolved.`] };
  return { accepted: true, blockers: [] };
}
