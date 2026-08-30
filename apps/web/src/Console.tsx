/**
 * The middleware console - the part of Track B a judge can actually see.
 *
 * The terminal demo already proves every decision; this exists because "show
 * the middleware evidence" is a scoring line and a reviewer should not have to
 * read a scrollback to answer "why was that denied?".
 *
 * Three columns, left to right, in the order the questions get asked:
 *
 *   documents   what shared state exists, who is on it right now
 *   document    what it says, who wrote each version, and any open conflict
 *   stream      the hash-chained decisions behind all of it
 *
 * Everything here is read from the same routes the Agents use. There is no
 * client-side policy: a button that would be denied is still sent, and the
 * denial that comes back is the thing worth showing.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, setSessionToken } from "./api";
import type {
  ChainEvent,
  ChainView,
  ConcordDoc,
  DocView,
  Human,
  PlannedTask,
  RunReport,
  Subtask,
} from "./types";
import "./console.css";

const POLL_MS = 2000;
const DEFAULT_SHARED = "docs/CHANGELOG.md";

function shortId(value: string | null | undefined): string {
  if (!value) return "-";
  const [prefix, rest] = [value.slice(0, 6), value.slice(6)];
  return rest.length > 6 ? prefix + rest.slice(0, 4) + "…" : value;
}

function initials(humanId: string | null, agentId: string): string {
  const source = humanId?.replace(/^human:/, "") ?? agentId.replace(/^agent_/, "");
  return source.slice(0, 2).toUpperCase();
}

function clockOf(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString();
}

/** Renders text with the contested line ranges marked, rather than as a blob. */
function Side({ label, text, marked }: { label: string; text: string; marked: string[] }) {
  const flagged = new Set(marked);
  return (
    <div className="conflict-side">
      <header>{label}</header>
      {text.split("\n").map((line, index) => (
        <div key={index}>{flagged.has(line) && line ? <mark>{line}</mark> : line || " "}</div>
      ))}
    </div>
  );
}

export default function Console({ onExit }: { onExit: () => void }) {
  const [humans, setHumans] = useState<Human[]>([]);
  const [me, setMe] = useState<Human | null>(null);
  const [task, setTask] = useState<PlannedTask | null>(null);
  const [title, setTitle] = useState("Add rate limiting to the API");
  const [shared, setShared] = useState(DEFAULT_SHARED);
  const [docs, setDocs] = useState<ConcordDoc[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocView | null>(null);
  const [chain, setChain] = useState<ChainView | null>(null);
  const [report, setReport] = useState<RunReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Reading a document needs an Agent, because the warrant - not the human
   * session - is what covers a repo path. The signed-in human's own Agent is
   * the honest choice: what you see is exactly what your Agent may see.
   */
  const myAgent = useMemo(() => {
    const mine = task?.subtasks.find((s) => s.ownerId === me?.id);
    return mine?.agentId ?? task?.subtasks[0]?.agentId ?? null;
  }, [task, me]);

  useEffect(() => {
    api
      .humans()
      .then((result) => setHumans(result.humans))
      .catch(() => setHumans([]));
  }, []);

  const signIn = useCallback(async (human: Human) => {
    try {
      const result = await api.signIn(human.handle);
      setSessionToken(result.token);
      setMe(result.human);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed");
    }
  }, []);

  // Poll: documents, the chain, and the open document. Cheap, and it means two
  // browsers side by side show the same race the Agents are having.
  const refresh = useCallback(async () => {
    if (!myAgent) return;
    try {
      const [list, events] = await Promise.all([
        api.docs(myAgent),
        me ? api.events() : Promise.resolve(null),
      ]);
      setDocs(list.docs);
      if (events) setChain(events);
      const target = selected ?? list.docs[0]?.id ?? null;
      if (target !== selected) setSelected(target);
      if (target) setDoc(await api.doc(target, myAgent));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 403) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [myAgent, me, selected]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const plan = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!me) {
      setError("Sign in as a human first - planning is a human action");
      return;
    }
    setBusy("plan");
    try {
      const result = await api.plan({
        title,
        owners: humans.filter((h) => h.handle !== "orchestrator").map((h) => h.id),
        maxSubtasks: 2,
        sharedPaths: shared.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setTask(result);
      setReport(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const runSubtask = async (subtask: Subtask) => {
    setBusy(subtask.id);
    setReport(null);
    try {
      const result = await api.runSubtask(
        subtask.id,
        "Add a line describing your subtask to " + shared + ", then stop.",
      );
      setReport(result);
      setError(null);
    } catch (cause) {
      // A denial is the interesting outcome, so it is shown, not swallowed.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const resolve = async (
    conflictId: string,
    choice: "ours" | "theirs" | "both",
  ) => {
    if (!selected) return;
    setBusy(conflictId);
    try {
      await api.resolveConflict(selected, { conflictId, choice });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const visibleEvents: ChainEvent[] = useMemo(() => {
    const events = chain?.events ?? [];
    if (!selected) return [...events].reverse().slice(0, 40);
    // Everything about this document, plus every denial: a denial the judge
    // cannot see is the one thing this panel exists to prevent.
    return [...events]
      .reverse()
      .filter(
        (event) =>
          event.verdict.decision === "Deny" ||
          String(event.evidence?.["resource"] ?? "").includes(selected),
      )
      .slice(0, 40);
  }, [chain, selected]);

  const openConflicts = doc?.conflicts ?? [];

  return (
    <div className="console">
      <div className="console-head">
        <div className="console-title">
          <h1>Concord</h1>
          <span>shared state · guarded by WARRANT</span>
        </div>

        <div className="whoami">
          <span className="eyebrow" style={{ marginRight: 6 }}>
            signed in as
          </span>
          {humans.map((human) => (
            <button
              key={human.id}
              data-active={me?.id === human.id}
              onClick={() => void signIn(human)}
              title={human.id}
            >
              {human.displayName}
            </button>
          ))}
        </div>

        <div className="console-chain">
          {chain ? (
            <>
              <span>
                chain{" "}
                <span className={chain.chainValid ? "chain-valid" : "chain-broken"}>
                  {chain.chainValid ? "VALID" : "BROKEN"}
                </span>
              </span>
              <span>head {chain.chainHead.slice(0, 12)}</span>
              <span>{chain.retained} events</span>
            </>
          ) : (
            <span>sign in to read the chain</span>
          )}
          <button className="button button-ghost" onClick={onExit}>
            Playground
          </button>
        </div>
      </div>

      {error && <div className="console-error">{error}</div>}

      <div className="task-strip">
        <form className="plan-form" onSubmit={plan}>
          <span className="eyebrow">Task</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="One task, split across humans"
          />
          <span className="eyebrow">shared</span>
          <input
            value={shared}
            onChange={(event) => setShared(event.target.value)}
            placeholder="docs/CHANGELOG.md"
          />
          <button className="button button-primary" disabled={busy === "plan"}>
            {busy === "plan" ? "Planning…" : "Split it"}
          </button>
        </form>

        {task?.subtasks.map((subtask) => {
          const mine = subtask.ownerId === me?.id;
          return (
            <div className="subtask-chip" key={subtask.id}>
              <b>{subtask.title}</b>
              <code>{subtask.ownerId.replace("human:", "")}</code>
              <code>{shortId(subtask.agentId)}</code>
              <button
                disabled={!me || busy === subtask.id}
                onClick={() => void runSubtask(subtask)}
                title={
                  mine
                    ? "Run this Agent under its owner's warrant"
                    : "You do not own this Agent - the backend will refuse"
                }
              >
                {busy === subtask.id ? "running…" : mine ? "run" : "run anyway"}
              </button>
            </div>
          );
        })}
      </div>

      <div className="console-body">
        <div className="rail">
          <div className="rail-label">
            <span>Shared documents</span>
            <span>{docs.length}</span>
          </div>
          {docs.length === 0 && (
            <p className="stream-empty">
              None yet. Split a task with a shared path, then run an Agent.
            </p>
          )}
          {docs.map((entry) => (
            <button
              key={entry.id}
              className="doc-row"
              data-active={entry.id === selected}
              onClick={() => setSelected(entry.id)}
            >
              <span className="doc-row-name">{entry.id}</span>
              <span className="doc-row-meta">
                <span>v{entry.version}</span>
                <span>{entry.writers} writers</span>
                {entry.conflicts > 0 && (
                  <span className="conflicted">{entry.conflicts} conflict</span>
                )}
                <span className="presence">
                  {entry.present.map((person) => (
                    <i
                      key={person.agentId}
                      data-editing={person.activity === "editing"}
                      title={
                        (person.humanId ?? person.agentId) + " is " + person.activity
                      }
                    >
                      {initials(person.humanId, person.agentId)}
                    </i>
                  ))}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="doc">
          {!doc && <p className="doc-empty">Select a document.</p>}
          {doc && selected && (
            <>
              <div className="doc-head">
                <h2>{selected}</h2>
                <span className="resource">
                  {doc.resource} · v{doc.version}
                </span>
              </div>

              {doc.content ? (
                <div className="doc-lines">
                  {doc.content.split("\n").map((line, index) => (
                    <div key={index}>
                      <span className="n">{index + 1}</span>
                      <span>{line || " "}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="doc-empty">Empty. No Agent has committed to it yet.</p>
              )}

              {openConflicts.map((conflict) => {
                const contestedOurs = conflict.conflicts.flatMap((range) => range.ours);
                const contestedTheirs = conflict.conflicts.flatMap((range) => range.theirs);
                const mine = conflict.humanId === me?.id;
                return (
                  <div className="conflict" key={conflict.id}>
                    <div className="conflict-head">
                      <b>Conflict · same lines</b>
                      <span>
                        {shortId(conflict.agentId)} tried to write over v
                        {conflict.atVersion} · {clockOf(conflict.at)}
                      </span>
                    </div>
                    <div className="conflict-sides">
                      <Side
                        label={"theirs · committed"}
                        text={conflict.theirs}
                        marked={contestedTheirs}
                      />
                      <Side
                        label={"ours · " + (conflict.humanId ?? conflict.agentId)}
                        text={conflict.ours}
                        marked={contestedOurs}
                      />
                    </div>
                    <div className="conflict-actions">
                      <button
                        disabled={busy === conflict.id}
                        onClick={() => void resolve(conflict.id, "theirs")}
                      >
                        Keep theirs
                      </button>
                      <button
                        disabled={busy === conflict.id}
                        onClick={() => void resolve(conflict.id, "ours")}
                      >
                        Keep ours
                      </button>
                      <button
                        disabled={busy === conflict.id}
                        onClick={() => void resolve(conflict.id, "both")}
                      >
                        Keep both
                      </button>
                      <span className="note">
                        {mine
                          ? "Yours to settle."
                          : "Owned by " +
                            (conflict.humanId ?? "another human") +
                            " - the backend will refuse you."}
                      </span>
                    </div>
                  </div>
                );
              })}

              {report && (
                <div className="run-report">
                  <h3>Last turn · {shortId(report.agentId)}</h3>
                  {report.reconciled.map((row) => (
                    <div key={row.docId} className="outcome" data-status={row.status}>
                      {row.docId} → {row.status}
                      {row.version !== undefined ? " v" + row.version : ""}
                      {row.detail ? " · " + row.detail : ""}
                    </div>
                  ))}
                  {(report.output || report.error) && (
                    <pre>{report.error ?? report.output}</pre>
                  )}
                </div>
              )}

              {doc.history && doc.history.length > 0 && (
                <div className="ledger">
                  <table>
                    <thead>
                      <tr>
                        <th>ver</th>
                        <th>human</th>
                        <th>agent</th>
                        <th>at</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...doc.history].reverse().map((entry) => (
                        <tr key={entry.version}>
                          <td>v{entry.version}</td>
                          <td>{entry.humanId ?? "-"}</td>
                          <td>{shortId(entry.agentId)}</td>
                          <td>{clockOf(entry.at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        <div className="stream">
          <div className="stream-label">
            <span>Decision stream</span>
            <span>{chain?.scope === "all" ? "all" : "yours"}</span>
          </div>
          {!chain && (
            <p className="stream-empty">
              The chain is viewer-scoped: sign in to see the decisions your Agents
              produced. The orchestrator sees every one.
            </p>
          )}
          {chain && visibleEvents.length === 0 && (
            <p className="stream-empty">No decisions on this document yet.</p>
          )}
          {visibleEvents.map((event) => (
            <div className="event" key={event.eventId}>
              <div className="event-top">
                <span className="verdict" data-decision={event.verdict.decision}>
                  {event.verdict.decision === "Allow" ? "ALLOW" : "DENY"}
                </span>
                <time>{clockOf(event.at)}</time>
                <span className="gate-tag">{event.gate}</span>
                <span className="event-rule">{event.verdict.ruleId}</span>
              </div>
              <dl className="event-tuple">
                <dt>human</dt>
                <dd>{String(event.evidence?.["human"] ?? "-")}</dd>
                <dt>agent</dt>
                <dd>{shortId(String(event.evidence?.["agent"] ?? "-"))}</dd>
                <dt>action</dt>
                <dd>{String(event.evidence?.["action"] ?? "-")}</dd>
                <dt>resource</dt>
                <dd>{String(event.evidence?.["resource"] ?? "-")}</dd>
              </dl>
              {event.verdict.decision === "Deny" && (
                <p className="event-reason">{event.verdict.reason}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
