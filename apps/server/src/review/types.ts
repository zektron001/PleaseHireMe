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
  | "failed";

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
  readonly createdByHumanId: string;
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
