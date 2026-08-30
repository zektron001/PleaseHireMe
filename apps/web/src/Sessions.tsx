/**
 * The sessions dashboard - "all of your team's sessions in one place".
 *
 * A session here is a planned Task: one objective, split across humans, with a
 * set of shared paths that CONCORD reconciles. That is the thing this platform
 * actually has, and it maps onto the reel's session cards without inventing a
 * new concept to sit beside it.
 */

import type { JSX } from "react";
import type { BoardSession } from "./types";
import { colorOf, humanName, initialsOf, shortId } from "./participants";

export function Sessions({
  sessions,
  activeId,
  viewer,
  onOpen,
}: {
  sessions: BoardSession[];
  activeId: string | null;
  viewer: string | null;
  onOpen: (session: BoardSession) => void;
}): JSX.Element {
  if (sessions.length === 0) {
    return (
      <div className="sessions-empty">
        <h2>No sessions yet</h2>
        <p>
          Split a task above. The orchestrator fans it out to one Agent per
          human, issues each a scoped warrant, and grants every one of them the
          shared paths you name — which is where CONCORD starts doing its job.
        </p>
      </div>
    );
  }

  return (
    <div className="sessions">
      {sessions.map((session) => {
        const conflicts = session.docs.reduce((sum, doc) => sum + doc.conflicts, 0);
        return (
          <button
            className={"session-card" + (session.id === activeId ? " is-active" : "")}
            key={session.id}
            onClick={() => onOpen(session)}
          >
            <div className="session-top">
              <span className={"session-state state-" + session.state}>
                {session.running > 0 ? (
                  <>
                    <i className="dot-live" />
                    {session.running} running
                  </>
                ) : (
                  session.state
                )}
              </span>
              {conflicts > 0 && (
                <span className="session-conflicts">{conflicts} conflict</span>
              )}
            </div>

            <h3>{session.title}</h3>

            <div className="session-people">
              {session.agents.map((agent) => (
                <span
                  key={agent.agentId}
                  className={"avatar" + (agent.mine ? " is-mine" : "")}
                  style={{ background: colorOf(agent.ownerId) }}
                  title={
                    humanName(agent.ownerId) +
                    " · " +
                    agent.title +
                    " · " +
                    shortId(agent.agentId)
                  }
                >
                  {initialsOf(agent.ownerId, agent.agentId)}
                </span>
              ))}
              <span className="session-owner">
                started by {humanName(session.createdBy)}
                {session.createdBy === viewer ? " (you)" : ""}
              </span>
            </div>

            <ul className="session-docs">
              {session.docs.length === 0 && (
                <li className="muted">no shared documents</li>
              )}
              {session.docs.map((doc) => (
                <li key={doc.id}>
                  <span className="mono">{doc.id}</span>
                  <span className="rev">rev {doc.version}</span>
                </li>
              ))}
            </ul>
          </button>
        );
      })}
    </div>
  );
}
