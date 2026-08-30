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
  BlameView,
  ChainEvent,
  ChainView,
  ConcordDoc,
  DocView,
  Human,
  PlannedTask,
  ReviewState,
  RunReport,
  Subtask,
} from "./types";
import { ReviewPanel } from "./Review";
import { applyTheme, readChoice, watchSystem, type ThemeChoice } from "./theme";
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

  const [review, setReview] = useState<ReviewState | null>(null);
  const [blame, setBlame] = useState<BlameView | null>(null);
  const [showBlame, setShowBlame] = useState(true);
  const [theme, setTheme] = useState<ThemeChoice>(() => readChoice());
  const [activity, setActivity] = useState<"docs" | "review" | "chain">("docs");
  const [panelOpen, setPanelOpen] = useState(true);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [anchorLine, setAnchorLine] = useState<number | null>(null);

  useEffect(() => {
    applyTheme(theme);
    // Only follow the OS while the choice actually is "follow the OS".
    if (theme !== "system") return;
    return watchSystem(() => applyTheme("system"));
  }, [theme]);

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
      if (target) {
        setDoc(await api.doc(target, myAgent));
        setBlame(await api.blame(target, myAgent).catch(() => null));
        if (me) {
          // A 403 here just means this human cannot review that document.
          setReview(await api.reviewState(target, myAgent).catch(() => null));
        }
      }
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
    // Everything about this document, plus every denial, plus the runtime gates.
    // A denial the judge cannot see is the one thing this panel exists to
    // prevent; and the AEGIS gates (admission, confinement, egress, attestation)
    // carry no `resource`, so filtering on that alone would hide the moment the
    // Agent actually crossed a boundary.
    return [...events]
      .reverse()
      .filter(
        (event) =>
          event.verdict.decision === "Deny" ||
          event.gate.startsWith("G") ||
          String(event.evidence?.["resource"] ?? "").includes(selected),
      )
      .slice(0, 40);
  }, [chain, selected]);

  const openConflicts = doc?.conflicts ?? [];
  const openReviewCount = (review?.comments ?? []).filter(
    (comment) => comment.status !== "resolved" && comment.status !== "stale",
  ).length;

  return (
    <div className="console ide">
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
          <button
            className="theme-toggle"
            title={"Theme: " + theme + " — click to cycle light / dark / system"}
            onClick={() =>
              setTheme((current) =>
                current === "light" ? "dark" : current === "dark" ? "system" : "light",
              )
            }
          >
            {theme === "light" ? "☀ light" : theme === "dark" ? "☾ dark" : "◐ system"}
          </button>
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

      <div className="ide-main">
        <nav className="activitybar">
          <button
            className="activity-item"
            data-active={activity === "docs"}
            title="Shared documents"
            onClick={() => setActivity("docs")}
          >
            🗎
          </button>
          <button
            className="activity-item"
            data-active={activity === "review"}
            title="Review comments"
            onClick={() => setActivity("review")}
          >
            ✎
            {openReviewCount > 0 && (
              <span className="activity-badge">{openReviewCount}</span>
            )}
          </button>
          <button
            className="activity-item"
            data-active={activity === "chain"}
            title="Decision chain"
            onClick={() => setActivity("chain")}
          >
            ⛓
          </button>
          <span className="activity-spacer" />
        </nav>

      <div className="console-body">
        <div className="rail">
          <div className="rail-label">
            <span>
              {activity === "docs"
                ? "Shared documents"
                : activity === "review"
                  ? "Review comments"
                  : "Recent decisions"}
            </span>
            <span>
              {activity === "docs"
                ? docs.length
                : activity === "review"
                  ? (review?.comments.length ?? 0)
                  : (chain?.events.length ?? 0)}
            </span>
          </div>

          {activity === "review" && (
            <>
              {(review?.comments.length ?? 0) === 0 && (
                <p className="stream-empty">
                  No comments on this document yet. Select lines in the editor to
                  leave one.
                </p>
              )}
              {review?.comments.map((comment) => (
                <button
                  key={comment.id}
                  className="doc-row"
                  onClick={() => setSelection({
                    start: comment.startLine,
                    end: comment.endLine,
                  })}
                  title="Show the lines this comment is anchored to"
                >
                  <span className="doc-row-name">{comment.body}</span>
                  <span className="doc-row-meta">
                    <span>
                      L{comment.startLine}
                      {comment.endLine !== comment.startLine
                        ? "\u2013" + comment.endLine
                        : ""}
                    </span>
                    <span>{shortId(comment.responsibleAgentId)}</span>
                    <span className={comment.status === "conflict" ? "conflicted" : ""}>
                      {comment.status}
                    </span>
                  </span>
                </button>
              ))}
            </>
          )}

          {activity === "chain" && (
            <>
              {(chain?.events.length ?? 0) === 0 && (
                <p className="stream-empty">
                  Sign in to read the chain. Every authorization and concurrency
                  outcome lands here.
                </p>
              )}
              {chain?.events.slice(0, 40).map((event) => (
                <div className="doc-row" key={event.eventId}>
                  <span className="doc-row-name">{event.verdict.ruleId}</span>
                  <span className="doc-row-meta">
                    <span
                      className={event.verdict.decision === "Deny" ? "conflicted" : ""}
                    >
                      {event.verdict.decision}
                    </span>
                    <span>{shortId(event.agentId)}</span>
                  </span>
                </div>
              ))}
            </>
          )}

          {activity === "docs" && docs.length === 0 && (
            <p className="stream-empty">
              None yet. Split a task with a shared path, then run an Agent.
            </p>
          )}
          {activity === "docs" && docs.map((entry) => (
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
          {docs.length > 0 && (
            <div className="tabstrip">
              {docs.map((entry) => (
                <button
                  key={entry.id}
                  className="tab"
                  data-active={entry.id === selected}
                  onClick={() => setSelected(entry.id)}
                  title={entry.id + " · v" + entry.version}
                >
                  <span
                    className="tab-dot"
                    data-state={
                      entry.conflicts > 0
                        ? "conflict"
                        : entry.present.some((who) => who.activity === "editing")
                          ? "editing"
                          : "idle"
                    }
                  />
                  {entry.id.split("/").at(-1)}
                  <span className="chain-seq">v{entry.version}</span>
                </button>
              ))}
            </div>
          )}
          {!doc && <p className="doc-empty">Select a document.</p>}
          {doc && selected && (
            <>
              <div className="doc-head">
                <h2>{selected}</h2>
                <span className="resource">
                  {doc.resource} · v{doc.version}
                </span>
                <button
                  className="ghost blame-toggle"
                  onClick={() => setShowBlame((value) => !value)}
                >
                  {showBlame ? "hide blame" : "show blame"}
                </button>
              </div>

              {doc.content ? (
                <div className="doc-lines selectable">
                  {doc.content.split("\n").map((line, index) => {
                    const number = index + 1;
                    const line_ = blame?.lines[index];
                    const attribution =
                      line_ && line_.lastModifiedByAgentId ? line_ : null;
                    const inRange =
                      selection !== null &&
                      number >= selection.start &&
                      number <= selection.end;
                    return (
                      <div
                        key={index}
                        className={inRange ? "line-selected" : undefined}
                        onClick={(event) => {
                          if (event.shiftKey && anchorLine !== null) {
                            setSelection({
                              start: Math.min(anchorLine, number),
                              end: Math.max(anchorLine, number),
                            });
                          } else {
                            setAnchorLine(number);
                            setSelection({ start: number, end: number });
                          }
                        }}
                      >
                        <span className="n">{number}</span>
                        {showBlame && (
                          <span
                            className="blame"
                            title={
                              attribution
                                ? "Last changed by " +
                                  attribution.lastModifiedByAgentId +
                                  " at v" +
                                  attribution.atVersion +
                                  (attribution.message ? " — " + attribution.message : "")
                                : "Not changed by any Agent"
                            }
                          >
                            {attribution ? shortId(attribution.lastModifiedByAgentId) : "—"}
                          </span>
                        )}
                        <span>{line || " "}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="doc-empty">Empty. No Agent has committed to it yet.</p>
              )}

              <ReviewPanel
                docId={selected}
                state={review}
                selection={selection}
                busy={busy !== null}
                onRefresh={() => void refresh()}
                onError={setError}
                onClearSelection={() => {
                  setSelection(null);
                  setAnchorLine(null);
                }}
              />

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

      <div className="panel">
        <div className="panel-tabs">
          <button
            className="panel-tab"
            data-active={true}
            onClick={() => setPanelOpen((open) => !open)}
          >
            Decision chain
          </button>
          <span className="chain-seq">{chain?.events.length ?? 0}</span>
          <span className="panel-spacer" />
          <button className="panel-tab" onClick={() => setPanelOpen((open) => !open)}>
            {panelOpen ? "collapse" : "expand"}
          </button>
        </div>
        <div className="panel-body" data-open={panelOpen}>
          {(chain?.events.length ?? 0) === 0 && (
            <p className="stream-empty">
              Sign in to read the chain. Every authorization and concurrency
              outcome lands here.
            </p>
          )}
          {chain?.events.map((event) => (
            <div className="chain-row" key={event.eventId}>
              <span className="chain-seq">{event.seq}</span>
              <span className="chain-verdict" data-decision={event.verdict.decision}>
                {event.verdict.decision}
              </span>
              <span className="chain-gate" title={event.gate}>
                {event.verdict.ruleId}
              </span>
              <span className="chain-reason">{event.verdict.reason}</span>
            </div>
          ))}
        </div>
      </div>

      <footer className="statusbar">
        <span>
          {me ? <b>{me.displayName}</b> : "not signed in"}
        </span>
        <span>{selected ? <b>{selected}</b> : "no document"}</span>
        {doc && <span>v{doc.version}</span>}
        <span className={openConflicts.length > 0 ? "bad" : ""}>
          {openConflicts.length} conflict{openConflicts.length === 1 ? "" : "s"}
        </span>
        <span className={openReviewCount > 0 ? "bad" : ""}>
          {openReviewCount} open comment{openReviewCount === 1 ? "" : "s"}
        </span>
        <span className="statusbar-spacer" />
        {chain && (
          <span className={chain.chainValid ? "ok" : "bad"}>
            chain {chain.chainValid ? "VALID" : "BROKEN"}
          </span>
        )}
        <span>{docs.length} document{docs.length === 1 ? "" : "s"}</span>
      </footer>
    </div>
  );
}
