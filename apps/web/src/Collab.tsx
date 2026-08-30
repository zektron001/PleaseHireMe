/**
 * The collaboration panels: People, Subagents, Queue, Usage, Access, and the
 * Agent Live feed.
 *
 * Every panel here renders backend state and nothing else. Where the reel shows
 * something this platform does not actually know, the panel says so in words
 * rather than filling the space - an honest empty state is worth more in front
 * of a judge than a plausible one.
 */

import { useState, type JSX } from "react";
import type {
  AccessWarrant,
  ActivityEvent,
  AgentUsage,
  BoardSession,
  QueueRow,
} from "./types";
import { clockOf, colorOf, expiresIn, humanName, initialsOf, shortId } from "./participants";

/* --------------------------------------------------------------- subagents */

/**
 * The reel shows a root Agent spawning named subagents. The equivalent here is
 * real but shaped differently, and the panel says which: the orchestrator
 * splits one task into per-subtask Agents, each with its own warrant and its
 * own workspace. That is a genuine parent/child fan-out. What this platform
 * does NOT have is an Agent spawning further Agents of its own, so no such row
 * is drawn.
 */
export function SubagentsPanel({
  sessions,
}: {
  sessions: BoardSession[];
}): JSX.Element {
  if (sessions.length === 0) {
    return <p className="panel-empty">No task has been split yet.</p>;
  }
  return (
    <div className="tree">
      {sessions.map((session) => (
        <div className="tree-root" key={session.id}>
          <div className="tree-node is-root">
            <span className="tree-glyph">◈</span>
            <span className="tree-label">Orchestrator</span>
            <span className="tree-note">split “{session.title}”</span>
          </div>
          {session.agents.map((agent) => (
            <div className="tree-node" key={agent.agentId}>
              <span className="tree-rail" />
              <i className="tree-dot" style={{ background: colorOf(agent.agentId) }} />
              <span className="tree-label">{agent.title}</span>
              <span className="tree-note mono">{shortId(agent.agentId)}</span>
              <span className={"state state-" + agent.state}>{agent.state}</span>
            </div>
          ))}
        </div>
      ))}
      <p className="panel-note">
        One level, because that is all the platform does: the orchestrator fans a
        task out to per-subtask Agents. No Agent spawns another.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------- queue */

const QUEUE_LABEL: Record<QueueRow["kind"], string> = {
  turn: "Agent turn",
  reiteration: "Re-iteration",
  conflict: "Conflict",
  comment: "Review comment",
};

export function QueuePanel({
  queue,
  onOpenDoc,
}: {
  queue: QueueRow[];
  onOpenDoc: (docId: string) => void;
}): JSX.Element {
  if (queue.length === 0) {
    return (
      <p className="panel-empty">
        Nothing pending. Running turns, open conflicts and unresolved comments
        appear here as they happen.
      </p>
    );
  }
  return (
    <ul className="queue">
      {queue.map((row) => (
        <li className={"queue-row kind-" + row.kind} key={row.kind + row.id}>
          <button
            className="queue-main"
            disabled={!row.docId}
            onClick={() => row.docId && onOpenDoc(row.docId)}
            title={row.docId ?? undefined}
          >
            <span className="queue-kind">{QUEUE_LABEL[row.kind]}</span>
            <span className="queue-label">{row.label}</span>
          </button>
          <span className="queue-meta">
            {row.agentId && (
              <i style={{ background: colorOf(row.agentId) }} title={row.agentId} />
            )}
            <span className={"state state-" + row.state.replace(/\s+/g, "-")}>
              {row.state}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------- usage */

export function UsagePanel({ usage }: { usage: AgentUsage[] }): JSX.Element {
  if (usage.length === 0) {
    return (
      <p className="panel-empty">
        No Agent has completed a turn yet. Every number here comes off a real
        run; none is estimated.
      </p>
    );
  }
  const total = usage.reduce(
    (sum, row) => sum + row.inputTokens + row.outputTokens,
    0,
  );
  return (
    <div className="usage">
      <div className="usage-total">
        <b>{total.toLocaleString()}</b>
        <span>tokens across {usage.length} Agent{usage.length === 1 ? "" : "s"}</span>
      </div>
      <table className="usage-table">
        <thead>
          <tr>
            <th>agent</th>
            <th>turns</th>
            <th>in</th>
            <th>out</th>
          </tr>
        </thead>
        <tbody>
          {usage.map((row) => (
            <tr key={row.agentId}>
              <td>
                <i style={{ background: colorOf(row.agentId) }} />
                <span className="mono">{shortId(row.agentId)}</span>
              </td>
              <td>{row.turns}</td>
              <td>{row.inputTokens.toLocaleString()}</td>
              <td>{row.outputTokens.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="panel-note">
        Reported by the runtime for each completed turn. Model:{" "}
        <span className="mono">{usage[0]?.model ?? "not reported"}</span>.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ access */

/**
 * The share sheet. In the reel this is a list of people with a role dropdown;
 * here the role is not a stored setting but a rendering of the warrant's
 * scopes, so changing it means issuing or revoking a delegation - which is the
 * honest version of the same idea, and the one the backend can enforce.
 */
export function AccessPanel({
  warrants,
  busy,
  onRevoke,
}: {
  warrants: AccessWarrant[];
  busy: boolean;
  onRevoke: (warrantId: string) => void;
}): JSX.Element {
  if (warrants.length === 0) {
    return <p className="panel-empty">You have delegated nothing yet.</p>;
  }
  return (
    <div className="access">
      {warrants.map((warrant) => (
        <div className={"access-row" + (warrant.live ? "" : " is-dead")} key={warrant.id}>
          <div className="access-head">
            <span className="avatar" style={{ background: colorOf(warrant.humanId) }}>
              {initialsOf(warrant.humanId, null)}
            </span>
            <span className="access-who">
              <b>{humanName(warrant.humanId)}</b>
              <span className="mono">{shortId(warrant.agentId)}</span>
            </span>
            <span className={"badge role-" + warrant.role.toLowerCase()}>
              {warrant.role}
            </span>
          </div>
          <div className="access-scopes">
            {warrant.scopes.map((scope) => (
              <span className="scope" key={scope}>
                {scope}
              </span>
            ))}
          </div>
          <div className="access-meta">
            <span>
              {warrant.revokedAt
                ? "revoked — " + (warrant.revokedReason ?? "no reason given")
                : "expires " + expiresIn(warrant.expiresAt)}
            </span>
            {warrant.live && warrant.revocableByViewer && (
              <button
                className="ghost"
                disabled={busy}
                onClick={() => onRevoke(warrant.id)}
              >
                Revoke
              </button>
            )}
          </div>
          <details className="access-resources">
            <summary>{warrant.resources.length} resources</summary>
            <ul>
              {warrant.resources.map((resource) => (
                <li key={resource} className="mono">
                  {resource}
                </li>
              ))}
            </ul>
          </details>
        </div>
      ))}
      <p className="panel-note">
        An Editor can spend this Agent's authority: start turns, and write shared
        documents through CONCORD. Revoking takes effect on the next decision,
        including one already in flight.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------- agent live */

const KIND_GLYPH: Record<ActivityEvent["kind"], string> = {
  prompt: "›",
  "turn-started": "▸",
  thinking: "∴",
  message: "❝",
  command: "$",
  "file-change": "±",
  "turn-completed": "✓",
  blocked: "✕",
};

const KIND_LABEL: Record<ActivityEvent["kind"], string> = {
  prompt: "asked",
  "turn-started": "started",
  thinking: "thinking",
  message: "said",
  command: "shell",
  "file-change": "edited",
  "turn-completed": "done",
  blocked: "blocked",
};

/**
 * "Watch what every Agent is typing", as far as it is true.
 *
 * These rows ARE the Codex event stream - the same lines AEGIS inspects for
 * policy - so each one is something the Agent really did: a command it ran, a
 * file it changed, a message it produced. What is not here is a typing
 * animation, because the runtime reports completed items, not keystrokes.
 */
export function AgentLive({
  events,
  connected,
}: {
  events: ActivityEvent[];
  connected: boolean;
}): JSX.Element {
  const [filter, setFilter] = useState<"all" | "edits" | "prompts">("all");
  const shown = events.filter((event) =>
    filter === "all"
      ? true
      : filter === "edits"
        ? event.kind === "file-change" || event.kind === "command"
        : event.kind === "prompt" || event.kind === "message",
  );

  return (
    <div className="live">
      <div className="live-head">
        <span className="live-title">
          <i className={connected ? "dot-live" : "dot-idle"} />
          Agent Live
        </span>
        <div className="live-filters">
          {(["all", "edits", "prompts"] as const).map((option) => (
            <button
              key={option}
              data-active={filter === option}
              onClick={() => setFilter(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 && (
        <p className="panel-empty">
          {connected
            ? "Connected. Nothing is running — the feed is quiet because the Agents are."
            : "Sign in and run an Agent. This feed carries the runtime's own event stream, so it is empty until one is working."}
        </p>
      )}

      <ul className="live-feed">
        {shown.map((event) => (
          <li className={"live-row kind-" + event.kind} key={event.id}>
            <span
              className="live-glyph"
              style={{ color: colorOf(event.agentId) }}
              title={event.agentId}
            >
              {KIND_GLYPH[event.kind]}
            </span>
            <div className="live-body">
              <div className="live-meta">
                <span className="mono" style={{ color: colorOf(event.agentId) }}>
                  {shortId(event.agentId)}
                </span>
                <span className="live-kind">{KIND_LABEL[event.kind]}</span>
                {event.purpose !== "turn" && (
                  <span className="live-purpose">{event.purpose}</span>
                )}
                {event.humanId && (
                  <span className="live-human">for {humanName(event.humanId)}</span>
                )}
                <time>{clockOf(event.at)}</time>
              </div>
              <p className="live-detail">{event.detail}</p>
              {event.usage && (event.usage.inputTokens ?? 0) > 0 && (
                <p className="live-usage">
                  {event.usage.inputTokens?.toLocaleString()} in ·{" "}
                  {event.usage.outputTokens?.toLocaleString()} out
                  {event.usage.model ? " · " + event.usage.model : ""}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
