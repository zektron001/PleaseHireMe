import type { ActivityEvent, Agent, AgentRun, Consultation, Message, SystemInfo } from "./types";
import type {
  AgentContribution,
  AccessWarrant,
  AgentRouting,
  BlameView,
  ChainView,
  ConcordDoc,
  DocView,
  Human,
  PendingConflict,
  PlannedTask,
  ReiterationRun,
  ReviewComment,
  SectionAllocation,
  Subtask,
  WorkspaceFrame,
  LiveBoard,
  ReviewState,
  RunReport,
  DocSharing,
  ShareGrant,
  ShareRole,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

/**
 * The per-human session token from POST /api/warrant/session.
 *
 * Deliberately separate from `authToken`: the shared demo token says the
 * browser may talk to this server at all, while this one says WHICH human is
 * asking. They travel in the same header, so a request can carry one or the
 * other - never both - and the middleware routes want this one.
 */
let sessionToken = "";

export function setSessionToken(token: string): void {
  sessionToken = token.trim();
}

async function asHuman<T>(url: string, options?: RequestInit): Promise<T> {
  return request<T>(url, {
    ...options,
    headers: {
      ...options?.headers,
      ...(sessionToken ? { Authorization: "Bearer " + sessionToken } : {}),
    },
  });
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),

  // ------------------------------------------------------ WARRANT (Track B)
  humans: () => request<{ humans: Human[] }>("/api/warrant/humans"),
  signIn: (handle: string) =>
    request<{ token: string; human: Human }>(
      "/api/warrant/session",
      json({ handle }),
    ),
  tasks: () => asHuman<{ tasks: PlannedTask["task"][] }>("/api/warrant/tasks"),
  task: (id: string) => asHuman<PlannedTask>("/api/warrant/tasks/" + id),
  plan: (body: {
    title: string;
    owners: string[];
    maxSubtasks?: number;
    sharedPaths?: string[];
  }) => asHuman<PlannedTask>("/api/warrant/tasks", json(body)),
  runSubtask: (subtaskId: string, prompt: string) =>
    asHuman<RunReport>(
      "/api/warrant/subtasks/" + subtaskId + "/run",
      json({ prompt }),
    ),
  revoke: (warrantId: string, reason: string) =>
    asHuman<{ warrant: unknown }>("/api/warrant/revoke", json({ warrantId, reason })),
  events: () => asHuman<ChainView>("/api/warrant/events"),

  // ------------------------------------------------------------- CONCORD
  // Every CONCORD call is asHuman now: an agentId selects one of the caller's
  // own delegations, it does not authenticate. See warrant/access.ts.
  docs: (agentId: string) =>
    asHuman<{ docs: ConcordDoc[] }>("/api/concord/docs?agentId=" + encodeURIComponent(agentId)),
  doc: (docId: string, agentId: string) =>
    asHuman<DocView>(
      "/api/concord/docs/" +
        encodeURIComponent(docId) +
        "?agentId=" +
        encodeURIComponent(agentId),
    ),
  docHistory: (docId: string, agentId: string) =>
    asHuman<{ history: DocView["history"] }>(
      "/api/concord/docs/" +
        encodeURIComponent(docId) +
        "/history?agentId=" +
        encodeURIComponent(agentId),
    ),
  /** The commit log: one AgentContribution per accepted write. Never called
   *  before the Source Control view existed. */
  contributions: (docId: string, agentId: string) =>
    asHuman<{ id: string; version: number; contributions: AgentContribution[] }>(
      "/api/concord/docs/" +
        encodeURIComponent(docId) +
        "/contributions?agentId=" +
        encodeURIComponent(agentId),
    ),
  myConflicts: () =>
    asHuman<{ viewer: string; conflicts: PendingConflict[] }>("/api/concord/conflicts"),
  resolveConflict: (
    docId: string,
    body: { conflictId: string; choice: "ours" | "theirs" | "both" | "content"; content?: string },
  ) =>
    asHuman<{ outcome: { status: string } }>(
      "/api/concord/docs/" + encodeURIComponent(docId) + "/resolve",
      json(body),
    ),

  // -------------------------------------------------------- review loop
  reviewState: (docId: string, agentId: string) =>
    asHuman<ReviewState>(
      "/api/review/docs/" +
        encodeURIComponent(docId) +
        "/comments?agentId=" +
        encodeURIComponent(agentId),
    ),
  routeFor: (docId: string, agentId: string, startLine: number, endLine: number) =>
    asHuman<AgentRouting>(
      "/api/review/docs/" +
        encodeURIComponent(docId) +
        "/route?agentId=" +
        encodeURIComponent(agentId) +
        "&startLine=" +
        startLine +
        "&endLine=" +
        endLine,
    ),
  addComment: (
    docId: string,
    body: { startLine: number; endLine: number; body: string; targetAgentId?: string },
  ) =>
    asHuman<{ comment: ReviewComment }>(
      "/api/review/docs/" + encodeURIComponent(docId) + "/comments",
      json(body),
    ),
  resolveComment: (commentId: string) =>
    asHuman<{ comment: ReviewComment }>(
      "/api/review/comments/" + encodeURIComponent(commentId) + "/resolve",
      { method: "POST" },
    ),
  blame: (docId: string, agentId: string) =>
    asHuman<BlameView>(
      "/api/concord/docs/" +
        encodeURIComponent(docId) +
        "/blame?agentId=" +
        encodeURIComponent(agentId),
    ),
  reiterate: (commentIds: string[]) =>
    asHuman<{ runs: ReiterationRun[] }>("/api/review/reiterations", json({ commentIds })),

  /**
   * Sends every Agent-raised comment waiting on one of your idle Agents.
   *
   * Auto mode only. The server picks the comments; this call carries the
   * consent, which is why it is a normal signed-in request and not something an
   * Agent could ever make for itself.
   */
  autoReiterate: (taskId: string) =>
    asHuman<{ runs: ReiterationRun[] }>(
      "/api/review/tasks/" + encodeURIComponent(taskId) + "/auto-reiterate",
      json({}),
    ),

  consult: (body: {
    docId: string;
    agentId: string;
    startLine: number;
    endLine: number;
    question: string;
    targetAgentId?: string;
  }) =>
    asHuman<{ consultation: Consultation }>("/api/review/consultations", json(body)),
  consultations: (docId: string) =>
    asHuman<{ consultations: Consultation[] }>(
      "/api/review/docs/" + encodeURIComponent(docId) + "/consultations",
    ),

  // --------------------------------------------------------- sharing
  // Note what none of these send: a granter id. Who is sharing is read from
  // the session token on the server, so editing a request body cannot make
  // the grant come from somebody else.
  sharing: (docId: string) =>
    asHuman<DocSharing>("/api/share/docs/" + encodeURIComponent(docId)),
  sharedWithMe: () =>
    asHuman<{ viewer: string; grants: ShareGrant[] }>("/api/share/mine"),
  share: (docId: string, body: { granteeId: string; role: ShareRole; ttlMs?: number }) =>
    asHuman<{ grant: ShareGrant }>(
      "/api/share/docs/" + encodeURIComponent(docId),
      json(body),
    ),
  /** The grantee brings their own Agent, and only now is a warrant minted. */
  attachAgent: (grantId: string, agentId: string) =>
    asHuman<{ grant: ShareGrant; warrantId: string }>(
      "/api/share/grants/" + encodeURIComponent(grantId) + "/agent",
      json({ agentId }),
    ),
  unshare: (grantId: string, reason: string) =>
    asHuman<{ grant: ShareGrant }>(
      "/api/share/grants/" + encodeURIComponent(grantId) + "/revoke",
      json({ reason }),
    ),
  // ------------------------------------ orchestration, editing, live screens
  /** A direct human save. No agentId: the human is writing, not an Agent. */
  saveDoc: (docId: string, body: { expectedVersion: number; content: string; message?: string }) =>
    asHuman<{ outcome: { status: string; version?: number; content?: string } }>(
      "/api/concord/docs/" + encodeURIComponent(docId),
      { method: "PUT", body: JSON.stringify(body) },
    ),
  sections: (docId: string, agentId: string) =>
    asHuman<{ docId: string; allocations: SectionAllocation[] }>(
      "/api/concord/docs/" +
        encodeURIComponent(docId) +
        "/sections?agentId=" +
        encodeURIComponent(agentId),
    ),
  stopSubtask: (subtaskId: string) =>
    asHuman<{ stopped: boolean }>(
      "/api/warrant/subtasks/" + encodeURIComponent(subtaskId) + "/stop",
      { method: "POST" },
    ),
  autorun: (taskId: string, prompt?: string) =>
    asHuman<{ started: { subtaskId: string; agentId: string; title: string }[] }>(
      "/api/warrant/tasks/" + encodeURIComponent(taskId) + "/autorun",
      json(prompt ? { prompt } : {}),
    ),
  approve: (subtaskId: string) =>
    asHuman<{ subtask: Subtask }>(
      "/api/warrant/subtasks/" + encodeURIComponent(subtaskId) + "/approve",
      { method: "POST" },
    ),
  integrate: (taskId: string) =>
    asHuman<{ task: PlannedTask["task"] }>(
      "/api/warrant/tasks/" + encodeURIComponent(taskId) + "/integrate",
      { method: "POST" },
    ),
  workspaces: () =>
    asHuman<{ viewer: string; frames: WorkspaceFrame[] }>("/api/live/workspaces"),
  /** The live screens' push channel. Separate stream: a frame is a whole file. */
  workspaceStream: (onFrame: (frame: WorkspaceFrame) => void): (() => void) => {
    if (!sessionToken) return () => {};
    const source = new EventSource(
      "/api/live/workspace-stream?token=" + encodeURIComponent(sessionToken),
    );
    source.onmessage = (message) => {
      try {
        onFrame(JSON.parse(message.data) as WorkspaceFrame);
      } catch {
        // A malformed frame is dropped rather than breaking the stream.
      }
    };
    return () => source.close();
  },

  // ------------------------------------------------------- live plane
  board: () => asHuman<LiveBoard>("/api/live/board"),
  access: () =>
    asHuman<{ viewer: string; warrants: AccessWarrant[] }>("/api/live/access"),
  /**
   * The push half of the live board. The board poll above is the fallback and
   * remains sufficient on its own - this only makes it immediate.
   *
   * EventSource cannot carry an Authorization header, so the session token
   * travels in the query string. That is a real trade: it lands in server logs
   * where a header would not. Acceptable here because the token is a short
   * demo session, and the alternative is a WebSocket dependency for one
   * one-way stream.
   */
  stream: (onEvent: (event: ActivityEvent) => void): (() => void) => {
    if (!sessionToken) return () => {};
    const source = new EventSource(
      "/api/live/stream?token=" + encodeURIComponent(sessionToken),
    );
    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data) as ActivityEvent);
      } catch {
        // A malformed frame is dropped rather than breaking the stream.
      }
    };
    return () => source.close();
  },
};
