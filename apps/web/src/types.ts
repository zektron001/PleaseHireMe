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

export interface PresenceEntry {
  agentId: string;
  humanId: string | null;
  activity: "viewing" | "editing";
  at: number;
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

export interface BlameView {
  id: string;
  version: number;
  lines: BlameLine[];
}
