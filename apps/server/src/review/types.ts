/**
 * CONCORD review loop - provenance-routed human feedback.
 *
 * A human selects a line range, the platform resolves which Agent last changed
 * those lines, and the human's comment is routed to that Agent. The Agent's
 * revision comes back through CONCORD's normal write path, so merge, conflict
 * and denial behave exactly as they do for any other write.
 */

export type CommentStatus =
  | "open"
  | "in_progress"
  | "addressed"
  | "resolved"
  /** The code the comment was anchored to has changed underneath it. */
  | "stale"
  | "conflict"
  | "failed"
  /**
   * Two Agents could not settle it between them, so a human has to.
   *
   * Distinct from `stale` and `failed` because the Review panel hides `stale`
   * (Review.tsx) and `failed` reads as a platform fault. This one is a request
   * for a human decision, and it has to stay visible to get one.
   */
  | "blocked";

export interface ReviewComment {
  readonly id: string;
  readonly docId: string;
  /** Document version the comment was written against. */
  readonly baseVersion: number;
  readonly startLine: number;
  readonly endLine: number;
  /** Derived by the server from canonical content, never taken from the body. */
  readonly selectedText: string;
  /** SHA-256 of selectedText; how staleness is detected. */
  readonly selectedTextHash: string;
  readonly body: string;
  readonly responsibleAgentId: string;
  /**
   * The human accountable for this comment.
   *
   * For an Agent-authored comment this is the Agent's OWNER, not a session
   * holder - the Agent speaks on the authority its human delegated, which is
   * the WARRANT premise, and it keeps every existing reader of this field
   * correct without a second notion of who is answerable.
   */
  readonly createdByHumanId: string;
  /** The Agent that raised this, or null when a human did. */
  readonly createdByAgentId: string | null;
  /**
   * Re-iterations spent on this comment. The escalation budget: an
   * Agent-authored comment that burns it goes to `blocked` rather than round
   * four. Inherited by a reply, so opening a fresh comment cannot reset it.
   */
  rounds: number;
  /** Agent ids that have called this settled. Mutual resolve needs both ends. */
  agentResolved: string[];
  status: CommentStatus;
  lastReiterationRunId: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

export type ReiterationStatus =
  | "queued"
  | "running"
  | "written"
  | "merged"
  | "conflict"
  | "denied"
  | "leased"
  | "failed"
  | "no_change";

export interface ReiterationRun {
  readonly id: string;
  readonly docId: string;
  readonly agentId: string;
  readonly humanId: string;
  readonly commentIds: readonly string[];
  readonly baseVersion: number;
  status: ReiterationStatus;
  resultingVersion: number | null;
  /** Short and safe. Never a stack trace, never the compiled prompt. */
  error: string | null;
  readonly createdAt: string;
  completedAt: string | null;
}

export type ReviewEventType =
  | "comment.created"
  | "comment.resolved"
  | "comment.stale"
  | "reiteration.started"
  | "reiteration.completed"
  | "reiteration.failed";

export interface ReviewEvent {
  readonly id: string;
  readonly sequence: number;
  readonly docId: string;
  readonly actorType: "human" | "agent" | "system";
  readonly actorId: string;
  /** Short redacted summary. Never document content, never a prompt. */
  readonly summary: string;
  readonly type: ReviewEventType;
  readonly createdAt: string;
}

/** Who a comment on a range should go to. */
export interface AgentRouting {
  readonly recommendedAgentId: string | null;
  readonly candidateAgentIds: readonly string[];
  readonly ambiguous: boolean;
}
