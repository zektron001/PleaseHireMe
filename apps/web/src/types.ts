export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

// ---------------------------------------------------------------- middleware
// The shapes the WARRANT and CONCORD routes return. Kept beside the starter
// kit's own types rather than in a parallel folder, so there is one place to
// look for "what does the server send".

export interface Human {
  id: string;
  handle: string;
  displayName: string;
}

export interface Subtask {
  id: string;
  taskId: string;
  title: string;
  description: string;
  ownerId: string;
  agentId: string;
  model: string;
  paths: string[];
  state: string;
  warrantId: string | null;
  approvedBy: string | null;
}

export interface PlannedTask {
  task: {
    id: string;
    title: string;
    createdBy: string;
    createdAt: string;
    subtaskIds: string[];
    sharedPaths: string[];
    state: string;
  };
  subtasks: Subtask[];
  splitter?: string;
}

/**
 * Where an Agent's last committed edit ended.
 *
 * Computed by CONCORD from the diff it already runs to attribute lines, so it
 * is a fact about a commit rather than about a keystroke. `atVersion` is the
 * revision it refers to, which is what makes a stale caret legible instead of
 * misleading.
 */
export interface Caret {
  line: number;
  column: number;
  atVersion: number;
}

export interface PresenceEntry {
  agentId: string;
  humanId: string | null;
  activity: "viewing" | "editing";
  at: number;
  /** Absent until that Agent has committed at least once. */
  caret?: Caret;
}

export interface ConcordDoc {
  id: string;
  version: number;
  leasedBy: string | null;
  writers: number;
  conflicts: number;
  present: PresenceEntry[];
  updatedAt: string;
  updatedBy: string | null;
}

export interface MergeConflictRange {
  ours: string[];
  theirs: string[];
  base: string[];
  at: number;
}

export interface PendingConflict {
  id: string;
  docId: string;
  agentId: string;
  humanId: string | null;
  at: string;
  base: string;
  ours: string;
  theirs: string;
  atVersion: number;
  conflicts: MergeConflictRange[];
}

export interface DocView {
  status: string;
  version: number;
  content: string;
  resource: string;
  conflicts: PendingConflict[];
  present: { status: string; present?: PresenceEntry[] };
  history?: { version: number; agentId: string; humanId: string | null; at: string }[];
}

export interface ChainEvent {
  eventId: string;
  seq: number;
  at: string;
  runId: string;
  agentId: string;
  gate: string;
  verdict: { decision: string; ruleId: string; reason: string; severity: string };
  evidence?: Record<string, string | number | boolean>;
  hash: string;
}

export interface ChainView {
  viewer: string;
  scope: string;
  captureLevel: string;
  retained: number;
  pruned: number;
  chainHead: string;
  chainValid: boolean;
  events: ChainEvent[];
}

export interface ReconcileRow {
  docId: string;
  status: string;
  version?: number;
  conflictId?: string;
  detail?: string;
}

export interface RunReport {
  subtaskId: string;
  agentId: string;
  model?: string;
  output?: string;
  error?: string;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  materialized: { docId: string; status: string; version?: number; reason?: string }[];
  reconciled: ReconcileRow[];
}

/* ------------------------------------------------------- review loop --- */

export type CommentStatus =
  | "open"
  | "in_progress"
  | "addressed"
  | "resolved"
  | "stale"
  | "conflict"
  | "failed";

export interface ReviewComment {
  id: string;
  docId: string;
  baseVersion: number;
  startLine: number;
  endLine: number;
  selectedText: string;
  selectedTextHash: string;
  body: string;
  responsibleAgentId: string;
  createdByHumanId: string;
  status: CommentStatus;
  lastReiterationRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReiterationRun {
  id: string;
  docId: string;
  agentId: string;
  humanId: string;
  commentIds: string[];
  baseVersion: number;
  status: string;
  resultingVersion: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ReviewEvent {
  id: string;
  sequence: number;
  docId: string;
  actorType: "human" | "agent" | "system";
  actorId: string;
  type: string;
  summary: string;
  createdAt: string;
}

export interface ReviewState {
  comments: ReviewComment[];
  runs: ReiterationRun[];
  events: ReviewEvent[];
}

export interface Consultation {
  id: string;
  docId: string;
  agentId: string;
  humanId: string;
  baseVersion: number;
  startLine: number;
  endLine: number;
  question: string;
  answer: string | null;
  status: "queued" | "running" | "completed" | "failed";
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AgentRouting {
  recommendedAgentId: string | null;
  candidateAgentIds: string[];
  ambiguous: boolean;
}

export interface BlameLine {
  lineNumber: number;
  text: string;
  lineId: string | null;
  /** null means the line predates any Agent write, not that it is unknown. */
  lastModifiedByAgentId: string | null;
  contributionId: string | null;
  atVersion: number | null;
  message: string | null;
}

/**
 * One accepted write. This is the commit object of this platform: there is no
 * git, so the Source Control view is built from these plus `DocView.history`.
 * `summary` is the Agent's own `CONCORD-COMMIT:` line - see concord/checkpoint.ts.
 */
export interface AgentContribution {
  id: string;
  documentId: string;
  agentId: string;
  humanId: string | null;
  runId: string | null;
  baseVersion: number;
  resultingVersion: number;
  outcome: "written" | "merged";
  changedLineIds: string[];
  summary: string;
  createdAt: string;
  caret?: { line: number; column: number };
}

export interface BlameView {
  id: string;
  version: number;
  lines: BlameLine[];
}

/* --------------------------------------------------- live collaboration --- */
// What /api/live/* returns. Everything here is composed by the server from
// state that already existed - warrants, subtask states, CONCORD presence and
// conflicts, and the Codex event stream. Nothing on this board is simulated.

export type ActivityKind =
  | "prompt"
  | "turn-started"
  | "thinking"
  | "message"
  | "command"
  | "file-change"
  | "turn-completed"
  | "blocked";

export type ActivityPurpose = "turn" | "consultation" | "reiteration";

export interface ActivityEvent {
  id: string;
  at: string;
  agentId: string;
  subtaskId: string | null;
  humanId: string | null;
  purpose: ActivityPurpose;
  kind: ActivityKind;
  detail: string;
  usage?: { inputTokens?: number; outputTokens?: number; model?: string };
}

export interface AgentUsage {
  agentId: string;
  humanId: string | null;
  model: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  lastAt: string | null;
}

export interface SessionAgent {
  agentId: string;
  subtaskId: string;
  title: string;
  ownerId: string;
  model: string;
  state: string;
  /** True only for Agents this human delegated to; the rest are read-only. */
  mine: boolean;
}

export interface BoardSession {
  id: string;
  title: string;
  createdBy: string;
  createdAt: string;
  state: string;
  sharedPaths: string[];
  running: number;
  docs: { id: string; version: number; conflicts: number }[];
  participants: string[];
  agents: SessionAgent[];
}

export interface PersonAgent {
  agentId: string;
  subtaskId: string;
  title: string;
  state: string;
  model: string;
  warrantId: string | null;
  scopes: string[];
  /** Derived from the scopes above. Not a second permission model. */
  role: string;
  live: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  resources: string[];
  revocableByViewer: boolean;
}

export interface BoardPerson {
  id: string;
  handle: string;
  displayName: string;
  isOrchestrator: boolean;
  agents: PersonAgent[];
}

export interface QueueRow {
  kind: "turn" | "reiteration" | "conflict" | "comment";
  id: string;
  agentId: string | null;
  humanId: string | null;
  docId: string | null;
  label: string;
  state: string;
}

export interface LiveBoard {
  viewer: string;
  scope: "all" | "own";
  sessions: BoardSession[];
  people: BoardPerson[];
  queue: QueueRow[];
  usage: AgentUsage[];
  activity: ActivityEvent[];
}

export interface AccessWarrant {
  id: string;
  humanId: string;
  agentId: string;
  subtaskId: string;
  role: string;
  scopes: string[];
  resources: string[];
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  live: boolean;
  revocableByViewer: boolean;
}

/* ------------------------------------------------------- sharing --- */
// The Google Docs surface over WARRANT. A grant is an ACL row naming two
// humans and confers nothing on its own; authority appears only once the
// GRANTEE attaches one of their own Agents and a warrant is minted for it.
// See apps/server/src/warrant/sharing.ts for why it is built that way.

export type ShareRole = "viewer" | "commenter" | "editor";

/** One Agent the grantee brought, and the warrant minted for it. */
export interface ShareAgent {
  agentId: string;
  warrantId: string;
  live: boolean;
  expiresAt: string;
}

export interface ShareGrant {
  id: string;
  docId: string;
  role: ShareRole;
  grantedBy: string;
  grantedByName: string;
  granteeId: string;
  granteeName: string;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
  agents: ShareAgent[];
}

export interface DocSharing {
  docId: string;
  resource: string;
  viewer: string;
  /** False for a Viewer or Commenter: only writers may re-share. */
  canShare: boolean;
  /** The widest role the viewer may hand out. Attenuation, made visible. */
  maxRole: ShareRole | null;
  heldScopes: string[];
  grants: ShareGrant[];
  people: Human[];
}
