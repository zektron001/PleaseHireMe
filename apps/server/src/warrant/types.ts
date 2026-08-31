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
  | "merge:propose"
  | "comment:write";

export type WarrantAction =
  | "workspace.read"
  | "workspace.write"
  | "merge.propose"
  | "merge.integrate"
  | "task.read"
  | "comment.write";

/**
 * Where a warrant came from. `subtask` warrants are minted by the orchestrator
 * when a task is fanned out; `share` warrants are minted when one human shares
 * a document with another. Both are decided by the same PDP - sharing is a way
 * to obtain a warrant, never a way to act without one.
 */
export type WarrantOrigin = "subtask" | "share";

/**
 * A scoped, time-bound, revocable grant from one human to one Agent, over an
 * explicit resource set. Absence of a warrant is absence of authority - there
 * is no ambient permission anywhere in this design.
 */
export interface Warrant {
  readonly id: string;
  readonly humanId: string;
  readonly agentId: string;
  /** For a share warrant this is the grant id, not a subtask id. */
  readonly subtaskId: string;
  readonly origin: WarrantOrigin;
  /** The human who delegated this, when it came from a share. */
  readonly grantedBy: string | null;
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

/* ------------------------------------------------------------------ sharing */

/**
 * The three roles a document can be shared at, in the order they widen.
 *
 * Deliberately the Google Docs vocabulary, because that is the mental model
 * every developer already has. What is NOT borrowed is "anyone with the link":
 * a link is not a principal, so it cannot be named in a warrant, and a grant
 * that cannot name its holder cannot be revoked from them. See ShareGrant.
 */
export type ShareRole = "viewer" | "commenter" | "editor";

export const SHARE_ROLES: readonly ShareRole[] = ["viewer", "commenter", "editor"];

/**
 * The scopes each role carries. Every role is a strict superset of the one
 * before it, which is what lets `atMost` compare two roles by scope count
 * rather than by a hand-maintained ordering table.
 */
export const SCOPES_FOR_ROLE: Record<ShareRole, readonly WarrantScope[]> = {
  viewer: ["workspace:read"],
  commenter: ["workspace:read", "comment:write"],
  editor: ["workspace:read", "comment:write", "workspace:write", "merge:propose"],
};

/**
 * One human sharing one document with another, at a role, until an expiry.
 *
 * A grant is the ACL entry. It is not authority on its own: authority appears
 * only when the grantee attaches one of their OWN Agents to it and a warrant is
 * minted for that Agent. That indirection is the point - it is what lets a
 * collaborator bring their own Agent without the sharer ever holding, naming,
 * or being able to impersonate it.
 */
export interface ShareGrant {
  readonly id: string;
  readonly docId: string;
  /** The human who shared. Always taken from a session, never from a body. */
  readonly grantedBy: string;
  readonly granteeId: string;
  readonly role: ShareRole;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** Warrants minted from this grant, one per Agent the grantee attached. */
  agentWarrantIds: string[];
  revokedAt: string | null;
  revokedReason: string | null;
}
