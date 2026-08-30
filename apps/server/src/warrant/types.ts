/**
 * WARRANT - delegation and authorization plane. CodeJam Track B (The Bouncer).
 *
 * The problem the starter kit cannot express: when one task is fanned out to N
 * Agents, each acting for a DIFFERENT human, "is this Agent allowed to touch
 * this resource?" stops being a global question and becomes a per-delegation
 * one. A warrant is that delegation made explicit, scoped, expiring and
 * revocable.
 *
 *   Human  --issues-->  Warrant  --authorises-->  Agent  --acts on-->  Resource
 *
 * Every authorization decision names all five: human, agent, action, resource,
 * decision. That five-tuple is the Track B acceptance requirement.
 */

/** A real person. Mock in this POC, an OIDC subject in production. */
export interface HumanPrincipal {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
}

/**
 * A non-human principal. Never exists on its own: it is always derived from a
 * warrant, and therefore always strictly narrower than the human who issued it.
 */
export interface WarrantAgentPrincipal {
  readonly kind: "agent";
  readonly agentId: string;
  readonly ownerId: string;
  readonly warrantId: string;
  readonly scopes: readonly WarrantScope[];
}

export type WarrantScope =
  | "workspace:read"
  | "workspace:write"
  | "model:invoke"
  | "merge:propose";

export type WarrantAction =
  | "workspace.read"
  | "workspace.write"
  | "merge.propose"
  | "merge.integrate"
  | "task.read";

/**
 * A scoped, time-bound, revocable grant from one human to one Agent, for one
 * subtask, over an explicit resource set. Absence of a warrant is absence of
 * authority - there is no ambient permission anywhere in this design.
 */
export interface Warrant {
  readonly id: string;
  readonly humanId: string;
  readonly agentId: string;
  readonly subtaskId: string;
  readonly scopes: readonly WarrantScope[];
  /** Canonical resource ids this warrant covers. Nothing else is reachable. */
  readonly resources: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export type SubtaskState =
  | "assigned"
  | "in_progress"
  | "submitted"
  | "approved"
  | "integrated"
  | "blocked";

export interface Subtask {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
  /** The human accountable for this subtask. Owns its workspace. */
  readonly ownerId: string;
  /** The Agent executing it, acting under the owner's warrant. */
  readonly agentId: string;
  /** Chosen by the orchestrator from the task shape - see model-policy.ts. */
  readonly model: string;
  /** Repo paths this subtask is allowed to change. */
  readonly paths: readonly string[];
  /**
   * The heading of the section this Agent is allocated in the shared document,
   * or null when the task has no shared document to divide. CONCORD refuses a
   * write that changes a line outside it - see concord/sections.ts.
   */
  readonly section: string | null;
  /** The shared document `section` refers to. */
  readonly sectionDoc: string | null;
  state: SubtaskState;
  warrantId: string | null;
  approvedBy: string | null;
  updatedAt: string;
}

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly subtaskIds: readonly string[];
  /**
   * Files granted to EVERY subtask, deliberately outside the partition. Held on
   * the task because they are the set CONCORD reconciles after each turn - the
   * warrants already carry them, but a warrant cannot say which of its resources
   * were shared rather than owned.
   */
  readonly sharedPaths: readonly string[];
  state: "planned" | "running" | "integrated";
}

/** The audit record Track B requires: who authorised whom to do what, and why. */
export interface AuthzDecision {
  readonly humanId: string | null;
  readonly agentId: string | null;
  readonly action: WarrantAction | "session.resolve" | "warrant.revoke";
  readonly resource: string;
  readonly decision: "Allow" | "Deny";
  readonly ruleId: string;
  readonly reason: string;
  readonly warrantId: string | null;
}

export interface Session {
  readonly token: string;
  readonly humanId: string;
  readonly issuedAt: string;
}
