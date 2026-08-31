/**
 * Agent identity, and the controls that spend it.
 *
 * A card per Agent rather than a row, because an Agent here is not a job in a
 * queue - it holds a warrant, a model, a slice of a file and a running bill,
 * and every one of those is something a human might want to check before
 * pressing run. The overall usage panel stays; this is the per-Agent half of it.
 */

import type { JSX } from "react";
import type { AgentRouting, BoardSession, SessionAgent } from "./types";
import { colorOf, shortId } from "./participants";

export function AgentCard({
  agent,
  busy,
  onRun,
  onStop,
  onApprove,
  onFocus,
}: {
  agent: SessionAgent;
  busy: boolean;
  onRun: () => void;
  onStop: () => void;
  onApprove: () => void;
  onFocus: () => void;
}): JSX.Element {
  const working = agent.state === "in_progress";
  const approved = agent.state === "approved" || agent.state === "integrated";
  const owner = agent.ownerId.replace(/^human:/, "");
  return (
    <div className={"agent-card" + (working ? " is-working" : "")}>
      <div className="agent-top" style={{ background: colorOf(agent.agentId) }} />
      <button className="agent-head" onClick={onFocus} title="Show this Agent's screen">
        <span className="agent-avatar" style={{ background: colorOf(agent.agentId) }}>
          {agent.title.slice(0, 2).toUpperCase()}
        </span>
        <span className="agent-name">
          <b>{agent.title}</b>
          <span className="mono">{shortId(agent.agentId)}</span>
        </span>
        <span className={"state state-" + agent.state}>
          {working ? "working" : agent.state}
        </span>
      </button>

      <p className={"agent-owner" + (agent.mine ? " is-mine" : "")}>
        {agent.mine ? (
          <>
            <b>Yours.</b> You hold the delegation behind this Agent, so you can run it.
          </>
        ) : (
          <>
            <b>{owner}&apos;s.</b> Sign in as {owner} to run this one — the backend
            refuses anyone else, whoever the browser claims to be.
          </>
        )}
      </p>

      <p className="agent-brief">{agent.description}</p>

      <dl className="agent-facts">
        <dt>model</dt>
        <dd className="mono">{agent.model}</dd>
        <dt>section</dt>
        <dd>
          {agent.section ? (
            <span className="mono">{agent.section.replace(/^#+\s*/, "")}</span>
          ) : (
            <span className="muted">whole file</span>
          )}
        </dd>
        <dt>turns</dt>
        <dd>{agent.turns}</dd>
        <dt>tokens</dt>
        <dd>
          {agent.turns === 0 ? (
            <span className="muted">none yet</span>
          ) : (
            <>
              {agent.inputTokens.toLocaleString()} in ·{" "}
              {agent.outputTokens.toLocaleString()} out
            </>
          )}
        </dd>
      </dl>

      <div className="agent-actions">
        {working ? (
          <button className="button button-stop" onClick={onStop} disabled={busy}>
            ■ Stop
          </button>
        ) : (
          <button
            className={"button " + (agent.mine ? "button-primary" : "button-foreign")}
            data-guide={agent.mine ? "run-task" : undefined}
            onClick={onRun}
            disabled={busy}
            title={
              agent.mine
                ? "Run this Agent under your own warrant"
                : "This Agent acts for " + owner + ". Running it is refused."
            }
          >
            {agent.mine ? "▶ Run task" : "▶ Run (not yours)"}
          </button>
        )}
        <button
          className="ghost"
          data-guide="approve-agent"
          onClick={onApprove}
          disabled={busy || working || approved}
          title={
            approved
              ? "Already approved"
              : agent.mine
                ? "Approve this Agent's work so the task can be merged"
                : "Only " + owner + " may approve this one"
          }
        >
          {approved ? "✓ approved" : "Approve"}
        </button>
      </div>
    </div>
  );
}

export function AgentBoard({
  session,
  busy,
  auto,
  onRun,
  onStop,
  onApprove,
  onFocus,
  onAutorun,
  onIntegrate,
  onToggleAuto,
}: {
  session: BoardSession | null;
  busy: boolean;
  auto: boolean;
  onRun: (agent: SessionAgent) => void;
  onStop: (agent: SessionAgent) => void;
  onApprove: (agent: SessionAgent) => void;
  onFocus: (agent: SessionAgent) => void;
  onAutorun: () => void;
  onIntegrate: () => void;
  onToggleAuto: () => void;
}): JSX.Element {
  if (!session) {
    return (
      <div className="screens-empty">
        <h2>Nothing planned yet</h2>
        <p>
          Name a goal and a file above, then press <b>Plan &amp; allocate</b>. The
          orchestrator splits the work, gives each Agent its own section of the
          file, and issues each a scoped warrant.
        </p>
      </div>
    );
  }

  const integrated = session.state === "integrated";

  return (
    <div className="agent-board">
      <div className="board-bar">
        <div className="board-title">
          <h2>{session.title}</h2>
          <span className="mono">
            {session.agents.length} agents · {session.sharedPaths.join(", ")}
          </span>
        </div>

        <label className="auto-toggle" title="Start every idle Agent as soon as it is ready">
          <input type="checkbox" checked={auto} onChange={onToggleAuto} />
          <span>Auto mode</span>
        </label>

        <button
          className="button"
          disabled={busy || session.running > 0}
          onClick={onAutorun}
          title="Start every idle Agent at once, each in its own sandbox"
        >
          ▶▶ Run all
        </button>

        <button
          className="button button-merge"
          data-guide="merge-all"
          disabled={busy || !session.readyToIntegrate || integrated}
          onClick={onIntegrate}
          title={
            integrated
              ? "Already merged"
              : session.readyToIntegrate
                ? "Every Agent approved and nothing contested — merge the task"
                : "Available once every Agent is approved and no conflict is open"
          }
        >
          {integrated ? "✓ Merged" : "⑃ Merge all work"}
        </button>
      </div>

      {!session.readyToIntegrate && !integrated && (
        <p className="board-gate">
          The merge stays closed until every Agent is approved and no document is
          contested — {session.pendingApproval.length} still to approve.
        </p>
      )}

      <div className="agent-grid">
        {session.agents.map((agent) => (
          <AgentCard
            key={agent.agentId}
            agent={agent}
            busy={busy}
            onRun={() => onRun(agent)}
            onStop={() => onStop(agent)}
            onApprove={() => onApprove(agent)}
            onFocus={() => onFocus(agent)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The consult confirmation.
 *
 * Selecting lines already tells the platform which Agent is responsible, from
 * CONCORD provenance. Asking a human to retype that id was making them do the
 * platform's job - and getting it wrong returned a 400. So: name the Agent,
 * ask yes or no.
 */
export function ConsultConfirm({
  routing,
  range,
  question,
  busy,
  onQuestion,
  onAsk,
  onPick,
  onCancel,
}: {
  routing: AgentRouting | null;
  range: { start: number; end: number };
  question: string;
  busy: boolean;
  onQuestion: (value: string) => void;
  onAsk: (agentId: string) => void;
  onPick: (agentId: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const lines =
    "Lines " + range.start + (range.end !== range.start ? "–" + range.end : "");

  if (!routing) {
    return (
      <div className="consult-confirm">
        <span className="selection-range">{lines}</span>
        <span className="muted">working out who wrote this…</span>
      </div>
    );
  }

  if (routing.humanAuthored && !routing.recommended) {
    return (
      <div className="consult-confirm">
        <span className="selection-range">{lines}</span>
        <span className="muted">
          You typed these lines yourself — no Agent is responsible for them.
        </span>
        <button className="ghost" onClick={onCancel}>
          dismiss
        </button>
      </div>
    );
  }

  if (routing.ambiguous) {
    return (
      <div className="consult-confirm is-ambiguous">
        <span className="selection-range">{lines}</span>
        <span>Several Agents changed these lines. Which one?</span>
        {routing.candidates.map((candidate) => (
          <button
            key={candidate.agentId}
            className="candidate"
            style={{ borderColor: colorOf(candidate.agentId) }}
            onClick={() => onPick(candidate.agentId)}
          >
            <i style={{ background: colorOf(candidate.agentId) }} />
            {candidate.title}
          </button>
        ))}
        <button className="ghost" onClick={onCancel}>
          cancel
        </button>
      </div>
    );
  }

  const agent = routing.recommended;
  if (!agent) {
    return (
      <div className="consult-confirm">
        <span className="selection-range">{lines}</span>
        <span className="muted">No Agent has changed these lines yet.</span>
        <button className="ghost" onClick={onCancel}>
          dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="consult-confirm">
      <span className="selection-range">{lines}</span>
      <span className="consult-who">
        <i style={{ background: colorOf(agent.agentId) }} />
        <b>{agent.title}</b> wrote this
        <span className="mono"> {shortId(agent.agentId)}</span>
      </span>
      <input
        className="selection-question"
        value={question}
        placeholder="Ask them about it, or leave blank to just comment…"
        onChange={(event) => onQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && question.trim()) onAsk(agent.agentId);
        }}
      />
      <button
        className="button button-primary"
        disabled={busy || !question.trim() || !agent.mine}
        onClick={() => onAsk(agent.agentId)}
        title={agent.mine ? "Ask this Agent" : "This Agent does not act for you"}
      >
        {busy ? "asking…" : "Ask " + agent.title.split(" ")[0]}
      </button>
      <button className="ghost" onClick={onCancel}>
        cancel
      </button>
    </div>
  );
}
