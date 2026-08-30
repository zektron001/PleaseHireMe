/**
 * The middleware console - the part of Track B a judge can actually see.
 *
 * The shape is borrowed from the multiplayer-IDE reel: a sessions dashboard, an
 * activity bar, collaborator panels, a code surface with attribution, a live
 * Agent feed, and an evidence rail. What is NOT borrowed is the parts of that
 * demo this platform cannot honestly back:
 *
 *   live character cursors   the runtime reports items, not keystrokes
 *   "agent is typing"        same reason; the feed shows completed items
 *   role dropdowns           a role here is a warrant's scopes, not a setting
 *
 * Everything rendered below is read from the same routes the Agents use. There
 * is no client-side policy: a button that would be denied is still sent, and
 * the denial that comes back is the thing worth showing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setSessionToken } from "./api";
import type {
  AccessWarrant,
  ActivityEvent,
  BlameView,
  BoardSession,
  ChainEvent,
  ChainView,
  ConcordDoc,
  Consultation,
  DocView,
  Human,
  LiveBoard,
  PlannedTask,
  ReviewState,
  RunReport,
  Subtask,
} from "./types";
import { ReviewPanel } from "./Review";
import { CodeView, type Selection } from "./Code";
import {
  AccessPanel,
  AgentLive,
  PeoplePanel,
  QueuePanel,
  SubagentsPanel,
  UsagePanel,
} from "./Collab";
import { Sessions } from "./Sessions";
import { clockOf, colorOf, humanName, initialsOf, shortId } from "./participants";
import { applyTheme, readChoice, watchSystem, type ThemeChoice } from "./theme";
import "./console.css";

const POLL_MS = 2000;
const DEFAULT_SHARED = "docs/CHANGELOG.md";

type Panel =
  | "sessions"
  | "files"
  | "people"
  | "queue"
  | "comments"
  | "subagents"
  | "usage"
  | "access";

const PANELS: { id: Panel; glyph: string; label: string }[] = [
  { id: "sessions", glyph: "▦", label: "Sessions" },
  { id: "files", glyph: "🗎", label: "Shared documents" },
  { id: "people", glyph: "👤", label: "People" },
  { id: "queue", glyph: "≡", label: "Queue" },
  { id: "comments", glyph: "✎", label: "Comments" },
  { id: "subagents", glyph: "◈", label: "Subagents" },
  { id: "usage", glyph: "◷", label: "Usage" },
  { id: "access", glyph: "🔑", label: "Share & access" },
];

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
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [doc, setDoc] = useState<DocView | null>(null);
  const [chain, setChain] = useState<ChainView | null>(null);
  const [report, setReport] = useState<RunReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [board, setBoard] = useState<LiveBoard | null>(null);
  const [warrants, setWarrants] = useState<AccessWarrant[]>([]);
  const [live, setLive] = useState<ActivityEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [session, setSession] = useState<string | null>(null);
  const [view, setView] = useState<"dashboard" | "workspace">("dashboard");

  const [review, setReview] = useState<ReviewState | null>(null);
  const [blame, setBlame] = useState<BlameView | null>(null);
  const [showBlame, setShowBlame] = useState(true);
  const [theme, setTheme] = useState<ThemeChoice>(() => readChoice());
  const [panel, setPanel] = useState<Panel>("sessions");
  const [bottomTab, setBottomTab] = useState<"chain" | "problems" | "output">("chain");
  const [bottomOpen, setBottomOpen] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [anchorLine, setAnchorLine] = useState<number | null>(null);
  const [question, setQuestion] = useState("");
  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [asking, setAsking] = useState(false);

  /**
   * Reading a document needs an Agent, because the warrant - not the human
   * session - is what covers a repo path. The signed-in human's own Agent is
   * the honest choice: what you see is exactly what your Agent may see. Since
   * the delegation gate landed, it is also the ONLY choice the server accepts.
   */
  const myAgent = useMemo(() => {
    const fromBoard = board?.sessions
      .flatMap((entry) => entry.agents)
      .find((agent) => agent.mine);
    const mine = task?.subtasks.find((s) => s.ownerId === me?.id);
    return mine?.agentId ?? fromBoard?.agentId ?? null;
  }, [task, me, board]);

  useEffect(() => {
    api
      .humans()
      .then((result) => setHumans(result.humans))
      .catch(() => setHumans([]));
  }, []);

  useEffect(() => {
    applyTheme(theme);
    // Only follow the OS while the choice actually is "follow the OS".
    if (theme !== "system") return;
    return watchSystem(() => applyTheme("system"));
  }, [theme]);

  const signIn = useCallback(async (human: Human) => {
    try {
      const result = await api.signIn(human.handle);
      setSessionToken(result.token);
      setMe(result.human);
      setError(null);
      setLive([]);
      setBoard(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed");
    }
  }, []);

  /**
   * The live feed, pushed. The board poll below carries the same events, so a
   * browser that cannot hold the stream open still shows a correct feed - just
   * two seconds behind. Nothing depends on this connection being up.
   */
  const closeStream = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!me) return;
    closeStream.current?.();
    setStreaming(true);
    closeStream.current = api.stream((event) => {
      setLive((current) => [event, ...current].slice(0, 200));
    });
    return () => {
      closeStream.current?.();
      closeStream.current = null;
      setStreaming(false);
    };
  }, [me]);

  // Poll: documents, the chain, the open document, and the collaboration board.
  // Cheap, and it means two browsers side by side show the same race the Agents
  // are having.
  const refresh = useCallback(async () => {
    if (!me) return;
    try {
      const [events, live] = await Promise.all([
        api.events().catch(() => null),
        api.board().catch(() => null),
      ]);
      if (events) setChain(events);
      if (live) {
        setBoard(live);
        // The stream is the fast path; the board is the one that is always
        // right. Merge rather than replace, so a dropped connection heals.
        setLive((current) => {
          const seen = new Set(current.map((event) => event.id));
          const missed = live.activity.filter((event) => !seen.has(event.id));
          return missed.length === 0
            ? current
            : [...missed, ...current]
                .sort((a, b) => b.at.localeCompare(a.at))
                .slice(0, 200);
        });
      }
      if (!myAgent) return;
      const list = await api.docs(myAgent);
      setDocs(list.docs);
      const target = selected ?? list.docs[0]?.id ?? null;
      if (target !== selected) setSelected(target);
      if (target) {
        setDoc(await api.doc(target, myAgent));
        setBlame(await api.blame(target, myAgent).catch(() => null));
        setReview(await api.reviewState(target, myAgent).catch(() => null));
        setConsultations(
          await api
            .consultations(target)
            .then((result) => result.consultations)
            .catch(() => []),
        );
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

  useEffect(() => {
    if (panel !== "access" || !me) return;
    void api
      .access()
      .then((result) => setWarrants(result.warrants))
      .catch(() => setWarrants([]));
  }, [panel, me, board]);

  // A document opened from anywhere becomes a tab, exactly like an IDE.
  useEffect(() => {
    if (!selected) return;
    setOpenTabs((tabs) => (tabs.includes(selected) ? tabs : [...tabs, selected]));
  }, [selected]);

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
      setSession(result.task.id);
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
      setBottomTab("output");
      setError(null);
    } catch (cause) {
      // A denial is the interesting outcome, so it is shown, not swallowed.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const resolve = async (conflictId: string, choice: "ours" | "theirs" | "both") => {
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

  const ask = async () => {
    if (!selected || !myAgent || !selection || !question.trim()) return;
    setAsking(true);
    try {
      await api.consult({
        docId: selected,
        agentId: myAgent,
        startLine: selection.start,
        endLine: selection.end,
        question: question.trim(),
      });
      setQuestion("");
      setError(null);
      void refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAsking(false);
    }
  };

  const revoke = async (warrantId: string) => {
    setBusy(warrantId);
    try {
      await api.revoke(warrantId, "Revoked from the access panel");
      setWarrants((await api.access()).warrants);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const selectLine = (line: number, extend: boolean) => {
    if (extend && anchorLine !== null) {
      setSelection({ start: Math.min(anchorLine, line), end: Math.max(anchorLine, line) });
    } else {
      setAnchorLine(line);
      setSelection({ start: line, end: line });
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

  const denials = useMemo(
    () => (chain?.events ?? []).filter((event) => event.verdict.decision === "Deny").reverse(),
    [chain],
  );

  const openConflicts = doc?.conflicts ?? [];
  const openReviewCount = (review?.comments ?? []).filter(
    (comment) => comment.status !== "resolved" && comment.status !== "stale",
  ).length;

  const activeSession = board?.sessions.find((entry) => entry.id === session) ?? null;
  const subtasks: Subtask[] = task?.subtasks ?? [];

  /** The capability this session actually holds, read off the live warrant. */
  const capability = useMemo(() => {
    const mine = board?.people.find((person) => person.id === me?.id);
    const agent = mine?.agents.find((entry) => entry.live);
    return agent ? agent.role : me ? "No delegation" : "Signed out";
  }, [board, me]);

  const badge = (id: Panel): number | null => {
    if (id === "sessions") return board?.sessions.length ?? null;
    if (id === "files") return docs.length || null;
    if (id === "people") return board?.people.filter((p) => p.agents.length > 0).length ?? null;
    if (id === "queue") return board?.queue.length || null;
    if (id === "comments") return openReviewCount || null;
    if (id === "usage") return board?.usage.length || null;
    if (id === "access") return warrants.filter((w) => w.live).length || null;
    return null;
  };

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
              <span className="avatar sm" style={{ background: colorOf(human.id) }}>
                {initialsOf(human.id, null)}
              </span>
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

        {subtasks.map((subtask) => {
          const mine = subtask.ownerId === me?.id;
          return (
            <div className="subtask-chip" key={subtask.id}>
              <i className="chip-dot" style={{ background: colorOf(subtask.agentId) }} />
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
          {PANELS.map((entry) => {
            const count = badge(entry.id);
            return (
              <button
                key={entry.id}
                className="activity-item"
                data-active={panel === entry.id}
                title={entry.label}
                onClick={() => {
                  setPanel(entry.id);
                  if (entry.id === "sessions") setView("dashboard");
                }}
              >
                {entry.glyph}
                {count !== null && count > 0 && (
                  <span className="activity-badge">{count}</span>
                )}
              </button>
            );
          })}
          <span className="activity-spacer" />
        </nav>

        <div className="console-body">
          <div className="rail">
            <div className="rail-label">
              <span>{PANELS.find((entry) => entry.id === panel)?.label}</span>
              <span>{badge(panel) ?? ""}</span>
            </div>

            {!me && (
              <p className="panel-empty">
                Sign in as a human above. Every panel here is scoped to the
                delegations you actually hold.
              </p>
            )}

            {me && panel === "sessions" && (
              <>
                {(board?.sessions ?? []).map((entry) => (
                  <button
                    key={entry.id}
                    className="doc-row"
                    data-active={entry.id === session}
                    onClick={() => {
                      setSession(entry.id);
                      setView("workspace");
                      const first = entry.docs[0]?.id;
                      if (first) setSelected(first);
                    }}
                  >
                    <span className="doc-row-name">{entry.title}</span>
                    <span className="doc-row-meta">
                      <span>{entry.agents.length} agents</span>
                      {entry.running > 0 && <span className="running">running</span>}
                    </span>
                  </button>
                ))}
                {(board?.sessions.length ?? 0) === 0 && (
                  <p className="panel-empty">
                    No sessions. Split a task above to create one.
                  </p>
                )}
              </>
            )}

            {me && panel === "files" && (
              <>
                {docs.length === 0 && (
                  <p className="panel-empty">
                    None yet. Split a task with a shared path, then run an Agent.
                  </p>
                )}
                {docs.map((entry) => (
                  <button
                    key={entry.id}
                    className="doc-row"
                    data-active={entry.id === selected}
                    onClick={() => {
                      setSelected(entry.id);
                      setView("workspace");
                    }}
                  >
                    <span className="doc-row-name">{entry.id}</span>
                    <span className="doc-row-meta">
                      <span>rev {entry.version}</span>
                      <span>{entry.writers} writers</span>
                      {entry.conflicts > 0 && (
                        <span className="conflicted">{entry.conflicts} conflict</span>
                      )}
                      <span className="presence">
                        {entry.present.map((person) => (
                          <i
                            key={person.agentId}
                            data-editing={person.activity === "editing"}
                            style={{ background: colorOf(person.humanId ?? person.agentId) }}
                            title={
                              (person.humanId ?? person.agentId) + " is " + person.activity
                            }
                          >
                            {initialsOf(person.humanId, person.agentId)}
                          </i>
                        ))}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            )}

            {me && panel === "people" && (
              <PeoplePanel people={board?.people ?? []} viewer={me.id} />
            )}
            {me && panel === "subagents" && (
              <SubagentsPanel sessions={board?.sessions ?? []} />
            )}
            {me && panel === "queue" && (
              <QueuePanel
                queue={board?.queue ?? []}
                onOpenDoc={(docId) => {
                  setSelected(docId);
                  setView("workspace");
                }}
              />
            )}
            {me && panel === "usage" && <UsagePanel usage={board?.usage ?? []} />}
            {me && panel === "access" && (
              <AccessPanel
                warrants={warrants}
                busy={busy !== null}
                onRevoke={(id) => void revoke(id)}
              />
            )}
            {me && panel === "comments" && (
              <>
                {(review?.comments.length ?? 0) === 0 && (
                  <p className="panel-empty">
                    No comments on this document yet. Select lines in the editor
                    to leave one.
                  </p>
                )}
                {review?.comments.map((comment) => (
                  <button
                    key={comment.id}
                    className="doc-row"
                    onClick={() =>
                      setSelection({ start: comment.startLine, end: comment.endLine })
                    }
                    title="Show the lines this comment is anchored to"
                  >
                    <span className="doc-row-name">{comment.body}</span>
                    <span className="doc-row-meta">
                      <span>
                        L{comment.startLine}
                        {comment.endLine !== comment.startLine
                          ? "–" + comment.endLine
                          : ""}
                      </span>
                      <span style={{ color: colorOf(comment.responsibleAgentId) }}>
                        {shortId(comment.responsibleAgentId)}
                      </span>
                      <span className={comment.status === "conflict" ? "conflicted" : ""}>
                        {comment.status}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>

          <div className="doc">
            {view === "dashboard" ? (
              <Sessions
                sessions={board?.sessions ?? []}
                activeId={session}
                viewer={me?.id ?? null}
                onOpen={(entry) => {
                  setSession(entry.id);
                  setView("workspace");
                  const first = entry.docs[0]?.id;
                  if (first) setSelected(first);
                }}
              />
            ) : (
              <>
                {openTabs.length > 0 && (
                  <div className="tabstrip">
                    <button
                      className="tab tab-back"
                      onClick={() => setView("dashboard")}
                      title="Back to sessions"
                    >
                      ▦
                    </button>
                    {openTabs.map((tabId) => {
                      const entry = docs.find((item) => item.id === tabId);
                      return (
                        <button
                          key={tabId}
                          className="tab"
                          data-active={tabId === selected}
                          onClick={() => setSelected(tabId)}
                          title={tabId + (entry ? " · rev " + entry.version : "")}
                        >
                          <span className="tab-people">
                            {(entry?.present ?? []).map((who) => (
                              <i
                                key={who.agentId}
                                className="tab-dot"
                                data-state={who.activity}
                                style={{
                                  background: colorOf(who.humanId ?? who.agentId),
                                }}
                                title={
                                  (who.humanId ?? who.agentId) + " is " + who.activity
                                }
                              />
                            ))}
                            {entry && entry.conflicts > 0 && (
                              <i className="tab-dot" data-state="conflict" />
                            )}
                          </span>
                          {tabId.split("/").at(-1)}
                          <span className="chain-seq">rev {entry?.version ?? "?"}</span>
                          <span
                            className="tab-close"
                            role="button"
                            tabIndex={-1}
                            onClick={(event) => {
                              event.stopPropagation();
                              setOpenTabs((tabs) => tabs.filter((id) => id !== tabId));
                              if (selected === tabId) {
                                setSelected(
                                  openTabs.find((id) => id !== tabId) ?? null,
                                );
                              }
                            }}
                          >
                            ×
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {!doc && <p className="doc-empty">Select a document.</p>}
                {doc && selected && (
                  <>
                    <div className="doc-head">
                      <h2>{selected}</h2>
                      <span className="resource">
                        {doc.resource} · rev {doc.version}
                      </span>
                      {activeSession && (
                        <span className="doc-session">{activeSession.title}</span>
                      )}
                      <button
                        className="ghost blame-toggle"
                        onClick={() => setShowBlame((value) => !value)}
                      >
                        {showBlame ? "hide blame" : "show blame"}
                      </button>
                    </div>

                    {doc.content ? (
                      <CodeView
                        docId={selected}
                        content={doc.content}
                        blame={blame?.lines ?? null}
                        present={doc.present?.present ?? []}
                        selection={selection}
                        showBlame={showBlame}
                        onSelect={selectLine}
                      />
                    ) : (
                      <p className="doc-empty">
                        Empty. No Agent has committed to it yet.
                      </p>
                    )}

                    {selection && (
                      <div className="selection-bar">
                        <span className="selection-range">
                          Lines {selection.start}
                          {selection.end !== selection.start ? "–" + selection.end : ""}
                        </span>
                        <input
                          className="selection-question"
                          value={question}
                          placeholder="Ask the responsible Agent about these lines…"
                          onChange={(event) => setQuestion(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void ask();
                          }}
                        />
                        <button
                          className="button button-ghost"
                          disabled={asking || !question.trim()}
                          onClick={() => void ask()}
                        >
                          {asking ? "asking…" : "Ask Agent"}
                        </button>
                        <button
                          className="ghost"
                          onClick={() => {
                            setSelection(null);
                            setAnchorLine(null);
                          }}
                        >
                          clear
                        </button>
                      </div>
                    )}

                    {consultations.length > 0 && (
                      <div className="consults">
                        <div className="review-head">
                          <b>Consultations</b>
                          <span className="review-count">
                            explanation only — canonical content unchanged
                          </span>
                        </div>
                        {consultations.slice(0, 4).map((item) => (
                          <div className="consult" key={item.id}>
                            <div className="consult-head">
                              <span
                                className="mono"
                                style={{ color: colorOf(item.agentId) }}
                              >
                                {shortId(item.agentId)}
                              </span>
                              <span>
                                L{item.startLine}
                                {item.endLine !== item.startLine
                                  ? "–" + item.endLine
                                  : ""}
                              </span>
                              <span className={"state state-" + item.status}>
                                {item.status}
                              </span>
                            </div>
                            <p className="consult-q">{item.question}</p>
                            {item.answer && <pre className="consult-a">{item.answer}</pre>}
                            {item.error && <p className="review-warn">{item.error}</p>}
                          </div>
                        ))}
                      </div>
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
                      const contestedTheirs = conflict.conflicts.flatMap(
                        (range) => range.theirs,
                      );
                      const mine = conflict.humanId === me?.id;
                      return (
                        <div className="conflict" key={conflict.id}>
                          <div className="conflict-head">
                            <b>Conflict detected — canonical code was not overwritten</b>
                            <span>
                              {shortId(conflict.agentId)} tried to write over rev
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

                    {doc.history && doc.history.length > 0 && (
                      <div className="ledger">
                        <table>
                          <thead>
                            <tr>
                              <th>rev</th>
                              <th>human</th>
                              <th>agent</th>
                              <th>at</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[...doc.history].reverse().map((entry) => (
                              <tr key={entry.version}>
                                <td>rev {entry.version}</td>
                                <td>{humanName(entry.humanId)}</td>
                                <td style={{ color: colorOf(entry.agentId) }}>
                                  {shortId(entry.agentId)}
                                </td>
                                <td>{clockOf(entry.at)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>

          <div className="stream">
            <AgentLive events={live} connected={streaming && me !== null} />

            <div className="stream-label">
              <span>Decision stream</span>
              <span>{chain?.scope === "all" ? "all" : "yours"}</span>
            </div>
            {!chain && (
              <p className="panel-empty">
                The chain is viewer-scoped: sign in to see the decisions your
                Agents produced. The orchestrator sees every one.
              </p>
            )}
            {chain && visibleEvents.length === 0 && (
              <p className="panel-empty">No decisions on this document yet.</p>
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
          {(["chain", "problems", "output"] as const).map((tab) => (
            <button
              key={tab}
              className="panel-tab"
              data-active={bottomTab === tab}
              onClick={() => {
                setBottomTab(tab);
                setBottomOpen(true);
              }}
            >
              {tab === "chain"
                ? "Decision chain"
                : tab === "problems"
                  ? "Problems"
                  : "Agent output"}
              {tab === "chain" && (
                <span className="chain-seq">{chain?.events.length ?? 0}</span>
              )}
              {tab === "problems" && denials.length + openConflicts.length > 0 && (
                <span className="chain-seq bad">
                  {denials.length + openConflicts.length}
                </span>
              )}
            </button>
          ))}
          <span className="panel-spacer" />
          <button className="panel-tab" onClick={() => setBottomOpen((open) => !open)}>
            {bottomOpen ? "collapse" : "expand"}
          </button>
        </div>

        <div className="panel-body" data-open={bottomOpen}>
          {bottomTab === "chain" && (
            <>
              {(chain?.events.length ?? 0) === 0 && (
                <p className="panel-empty">
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
            </>
          )}

          {bottomTab === "problems" && (
            <>
              {denials.length === 0 && openConflicts.length === 0 && (
                <p className="panel-empty">
                  Nothing refused and nothing contested. This panel fills up when
                  the middleware says no.
                </p>
              )}
              {openConflicts.map((conflict) => (
                <div className="chain-row" key={conflict.id}>
                  <span className="chain-verdict" data-decision="Deny">
                    CONFLICT
                  </span>
                  <span className="chain-gate">{conflict.docId}</span>
                  <span className="chain-reason">
                    {shortId(conflict.agentId)} wrote against rev {conflict.atVersion};
                    canonical content kept
                  </span>
                </div>
              ))}
              {denials.slice(0, 60).map((event) => (
                <div className="chain-row" key={event.eventId}>
                  <span className="chain-verdict" data-decision="Deny">
                    DENY
                  </span>
                  <span className="chain-gate" title={event.gate}>
                    {event.verdict.ruleId}
                  </span>
                  <span className="chain-reason">{event.verdict.reason}</span>
                </div>
              ))}
            </>
          )}

          {bottomTab === "output" && (
            <>
              {!report && (
                <p className="panel-empty">
                  No turn has been run from this browser yet.
                </p>
              )}
              {report && (
                <div className="run-report">
                  <h3>
                    Last turn · <span style={{ color: colorOf(report.agentId) }}>
                      {shortId(report.agentId)}
                    </span>
                    {report.model ? " · " + report.model : ""}
                  </h3>
                  {report.reconciled.map((row) => (
                    <div key={row.docId} className="outcome" data-status={row.status}>
                      {row.docId} → {row.status}
                      {row.version !== undefined ? " rev " + row.version : ""}
                      {row.detail ? " · " + row.detail : ""}
                    </div>
                  ))}
                  {(report.output || report.error) && (
                    <pre>{report.error ?? report.output}</pre>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <footer className="statusbar">
        <span>{me ? <b>{me.displayName}</b> : "not signed in"}</span>
        <span className="capability" title="Read from your live warrant's scopes">
          {capability}
        </span>
        <span>{selected ? <b>{selected}</b> : "no document"}</span>
        {doc && <span>rev {doc.version}</span>}
        <span className={openConflicts.length > 0 ? "bad" : ""}>
          {openConflicts.length} conflict{openConflicts.length === 1 ? "" : "s"}
        </span>
        <span className={openReviewCount > 0 ? "bad" : ""}>
          {openReviewCount} open comment{openReviewCount === 1 ? "" : "s"}
        </span>
        <span className="statusbar-spacer" />
        <span className={streaming ? "ok" : ""}>
          {streaming ? "live" : "polling"}
        </span>
        {chain && (
          <span className={chain.chainValid ? "ok" : "bad"}>
            chain {chain.chainValid ? "VALID" : "BROKEN"}
          </span>
        )}
        <span>
          {docs.length} document{docs.length === 1 ? "" : "s"}
        </span>
      </footer>
    </div>
  );
}
