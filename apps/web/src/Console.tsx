/**
 * The middleware console.
 *
 * The pitch this is the interface for: git and an editor were built for one
 * person at a time, and neither has an answer for six Agents writing one file
 * at once. This does.
 *
 * One operator. The orchestrator splits a goal into pieces, allocates one Agent
 * per piece AND one section of the file per Agent, and CONCORD refuses any
 * write that reaches outside. So "they do not collide" is enforced, not hoped
 * for - and the human can still type into the same file while they work.
 *
 * Three views, one file:
 *
 *   Agents    who is on what, with model, section, tokens, run / stop / approve
 *   Live      one pane per Agent, its real workspace copy as it changes on disk
 *   Editor    the canonical document, editable, autosaving through CONCORD
 *
 * Nothing here is simulated. Where the platform does not know something - an
 * Agent's caret between two file states, for instance - the interface says so
 * rather than drawing it.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setSessionToken } from "./api";
import type {
  AccessWarrant,
  ActivityEvent,
  AgentRouting,
  BlameView,
  ChainEvent,
  ChainView,
  ConcordDoc,
  Consultation,
  DocView,
  Human,
  LiveBoard,
  ReviewState,
  SectionAllocation,
  SessionAgent,
  WorkspaceFrame,
} from "./types";
import { ReviewPanel } from "./Review";
/**
 * Monaco is a megabyte even trimmed, and the Agents board - the first thing
 * anybody sees - does not need it. Splitting it out here keeps the initial load
 * to the shell, and the editor arrives while the human is reading the cards.
 */
const DocumentEditor = lazy(() =>
  import("./Editor").then((module) => ({ default: module.DocumentEditor })),
);
const LiveScreens = lazy(() =>
  import("./Screens").then((module) => ({ default: module.LiveScreens })),
);
import { AgentBoard, ConsultConfirm } from "./Agents";
import {
  AccessPanel,
  AgentLive,
  QueuePanel,
  SubagentsPanel,
  UsagePanel,
} from "./Collab";
import { clockOf, colorOf, shortId } from "./participants";
import { applyTheme, readChoice, resolve as resolveTheme, watchSystem, type ThemeChoice } from "./theme";
import "./console.css";

const POLL_MS = 2000;
const DEFAULT_DOC = "docs/CHANGELOG.md";

type View = "agents" | "live" | "editor";
type Panel = "outline" | "queue" | "comments" | "usage" | "access" | "chain";

const PANELS: { id: Panel; glyph: string; label: string; hint: string }[] = [
  { id: "outline", glyph: "🗎", label: "Files & sections", hint: "the shared documents and who owns which part" },
  { id: "queue", glyph: "≡", label: "Queue", hint: "running turns, open conflicts, unresolved comments" },
  { id: "comments", glyph: "✎", label: "Comments", hint: "your review comments and what came of them" },
  { id: "usage", glyph: "◷", label: "Usage", hint: "tokens each Agent actually spent" },
  { id: "access", glyph: "🔑", label: "Share & access", hint: "the warrants you issued, and revoke" },
  { id: "chain", glyph: "⛓", label: "Evidence", hint: "every authorization and concurrency decision" },
];

const VIEWS: { id: View; glyph: string; label: string }[] = [
  { id: "agents", glyph: "◈", label: "Agents" },
  { id: "live", glyph: "▶", label: "Live screens" },
  { id: "editor", glyph: "✎", label: "Editor" },
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
  const [me, setMe] = useState<Human | null>(null);
  const [goal, setGoal] = useState("Add rate limiting to the API");
  const [docPath, setDocPath] = useState(DEFAULT_DOC);
  const [pieces, setPieces] = useState(2);

  const [board, setBoard] = useState<LiveBoard | null>(null);
  const [docs, setDocs] = useState<ConcordDoc[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocView | null>(null);
  const [blame, setBlame] = useState<BlameView | null>(null);
  const [allocations, setAllocations] = useState<SectionAllocation[]>([]);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [chain, setChain] = useState<ChainView | null>(null);
  const [warrants, setWarrants] = useState<AccessWarrant[]>([]);

  const [live, setLive] = useState<ActivityEvent[]>([]);
  const [frames, setFrames] = useState<WorkspaceFrame[]>([]);
  const [streaming, setStreaming] = useState(false);

  const [view, setView] = useState<View>("agents");
  const [panel, setPanel] = useState<Panel>("outline");
  const [railOpen, setRailOpen] = useState(true);
  const [bottomTab, setBottomTab] = useState<"chain" | "problems" | "live">("live");
  const [bottomOpen, setBottomOpen] = useState(true);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);

  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [routing, setRouting] = useState<AgentRouting | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);

  const [theme, setTheme] = useState<ThemeChoice>(() => readChoice());
  const resolved = resolveTheme(theme);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    return watchSystem(() => applyTheme("system"));
  }, [theme]);

  /**
   * One operator, so signing in is not a choice the human should have to make.
   * The session still comes from the server and still carries every decision -
   * it is the ceremony that is gone, not the identity.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { humans } = await api.humans();
        const operator = humans[0];
        if (!operator || cancelled) return;
        const session = await api.signIn(operator.handle);
        if (cancelled) return;
        setSessionToken(session.token);
        setMe(session.human);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not start a session");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** The Agent this human reads documents through. Any of their own will do. */
  const readerAgent = useMemo(
    () => board?.sessions.flatMap((s) => s.agents).find((a) => a.mine)?.agentId ?? null,
    [board],
  );

  /**
   * The task in view. Defaults to the newest, but stays put once chosen -
   * planning a second task should not yank the first one out from under
   * somebody who is reading it.
   */
  const [taskId, setTaskId] = useState<string | null>(null);
  const sessions = board?.sessions ?? [];
  const session =
    sessions.find((entry) => entry.id === taskId) ?? sessions.at(-1) ?? null;
  const agents: SessionAgent[] = session?.agents ?? [];

  // ---- live streams. The board poll below carries the same data, so a browser
  // that cannot hold these open is two seconds behind rather than wrong.
  useEffect(() => {
    if (!me) return;
    setStreaming(true);
    const stopActivity = api.stream((event) =>
      setLive((current) => [event, ...current].slice(0, 200)),
    );
    const stopFrames = api.workspaceStream((frame) =>
      setFrames((current) => [
        frame,
        ...current.filter(
          (other) => other.agentId !== frame.agentId || other.docId !== frame.docId,
        ),
      ]),
    );
    return () => {
      stopActivity();
      stopFrames();
      setStreaming(false);
    };
  }, [me]);

  const refresh = useCallback(async () => {
    if (!me) return;
    try {
      const [events, next, ws] = await Promise.all([
        api.events().catch(() => null),
        api.board().catch(() => null),
        api.workspaces().catch(() => null),
      ]);
      if (events) setChain(events);
      if (next) {
        setBoard(next);
        setLive((current) => {
          const seen = new Set(current.map((event) => event.id));
          const missed = next.activity.filter((event) => !seen.has(event.id));
          return missed.length === 0
            ? current
            : [...missed, ...current].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
        });
      }
      if (ws && ws.frames.length > 0) {
        setFrames((current) => (current.length === 0 ? ws.frames : current));
      }

      const agentId =
        next?.sessions.flatMap((s) => s.agents).find((a) => a.mine)?.agentId ??
        readerAgent;
      if (!agentId) return;

      const list = await api.docs(agentId);
      setDocs(list.docs);
      const target = selected ?? next?.sessions.at(-1)?.docs[0]?.id ?? list.docs[0]?.id ?? null;
      if (target !== selected) setSelected(target);
      if (!target) return;

      setDoc(await api.doc(target, agentId));
      setBlame(await api.blame(target, agentId).catch(() => null));
      setAllocations(
        await api.sections(target, agentId).then((r) => r.allocations).catch(() => []),
      );
      setReview(await api.reviewState(target, agentId).catch(() => null));
      setConsultations(
        await api.consultations(target).then((r) => r.consultations).catch(() => []),
      );
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 403) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [me, selected, readerAgent]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (panel !== "access" || !me) return;
    void api.access().then((r) => setWarrants(r.warrants)).catch(() => setWarrants([]));
  }, [panel, me, board]);

  /** Auto mode: start anything idle, each time the board says something is. */
  useEffect(() => {
    if (!auto || !session || busy) return;
    if (session.running > 0) return;
    const idle = session.agents.filter((a) => a.mine && a.state === "assigned");
    if (idle.length === 0) return;
    void api.autorun(session.id).catch(() => undefined);
  }, [auto, session, busy]);

  const guard = async (key: string, run: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setError(null);
    try {
      await run();
      if (ok) setNotice(ok);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const plan = (event: React.FormEvent) => {
    event.preventDefault();
    if (!me) return;
    void guard(
      "plan",
      async () => {
        const result = await api.plan({
          title: goal,
          owners: [me.id],
          maxSubtasks: pieces,
          sharedPaths: [docPath.trim()],
        });
        setSelected(docPath.trim());
        setTaskId(result.task.id);
        setView("agents");
        return result;
      },
      "Planned. Each Agent owns one section of " + docPath.trim() + ".",
    );
  };

  const runAgent = (agent: SessionAgent) =>
    void guard("run:" + agent.subtaskId, () =>
      api.runSubtask(
        agent.subtaskId,
        // Kept identical to defaultPromptFor on the server - see warrant/routes.ts
        // for why each rule is there.
        agent.section
          ? [
              "Edit " + agent.sectionDoc + " and nothing else.",
              'Work ONLY inside the section headed "' + agent.section + '".',
              "Replace its placeholder line with your real contribution to: " +
                agent.description,
              "",
              "Rules:",
              "- Use apply_patch to make the edit. Do not run find, ls, sed or grep.",
              "- Read the file once if you need to; it is at a relative path.",
              "- Never use an absolute path, and never write outside this file.",
              "- Do not change any other section. The middleware will refuse it.",
            ].join("\n")
          : agent.description,
      ),
    );

  const stopAgent = (agent: SessionAgent) =>
    void guard("stop:" + agent.subtaskId, () => api.stopSubtask(agent.subtaskId));

  const approveAgent = (agent: SessionAgent) =>
    void guard("approve:" + agent.subtaskId, () => api.approve(agent.subtaskId));

  const saveDoc = useCallback(
    async (next: string): Promise<"written" | "stale" | "error"> => {
      if (!selected || !doc) return "error";
      try {
        const { outcome } = await api.saveDoc(selected, {
          expectedVersion: doc.version,
          content: next,
          message: "edited by hand",
        });
        void refresh();
        return outcome.status === "written" ? "written" : "stale";
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 409) return "stale";
        setError(cause instanceof Error ? cause.message : String(cause));
        return "error";
      }
    },
    [selected, doc, refresh],
  );

  /** Who wrote the selected lines. Resolved from provenance, never typed. */
  const lastRouted = useRef("");
  useEffect(() => {
    if (!selection || !selected || !readerAgent) {
      setRouting(null);
      return;
    }
    const key = selected + ":" + selection.start + ":" + selection.end;
    if (key === lastRouted.current) return;
    lastRouted.current = key;
    void api
      .routeFor(selected, readerAgent, selection.start, selection.end)
      .then(setRouting)
      .catch(() => setRouting(null));
  }, [selection, selected, readerAgent]);

  const ask = (agentId: string) => {
    if (!selected || !readerAgent || !selection || !question.trim()) return;
    setAsking(true);
    void api
      .consult({
        docId: selected,
        agentId: readerAgent,
        targetAgentId: agentId,
        startLine: selection.start,
        endLine: selection.end,
        question: question.trim(),
      })
      .then(() => {
        setQuestion("");
        setNotice("Asked. The answer lands below when the Agent replies.");
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => {
        setAsking(false);
        void refresh();
      });
  };

  const resolveConflict = (conflictId: string, choice: "ours" | "theirs" | "both") => {
    if (!selected) return;
    void guard(conflictId, () => api.resolveConflict(selected, { conflictId, choice }));
  };

  const openConflicts = doc?.conflicts ?? [];
  const openComments = (review?.comments ?? []).filter(
    (c) => c.status !== "resolved" && c.status !== "stale",
  ).length;
  const denials = useMemo(
    () => (chain?.events ?? []).filter((e) => e.verdict.decision === "Deny").reverse(),
    [chain],
  );
  const visibleChain: ChainEvent[] = useMemo(
    () => [...(chain?.events ?? [])].reverse().slice(0, 60),
    [chain],
  );
  const anyWorking = agents.some((a) => a.state === "in_progress");

  const badge = (id: Panel): number => {
    if (id === "outline") return docs.length;
    if (id === "queue") return board?.queue.length ?? 0;
    if (id === "comments") return openComments;
    if (id === "usage") return board?.usage.length ?? 0;
    if (id === "access") return warrants.filter((w) => w.live).length;
    return denials.length;
  };

  return (
    <div className="console ide">
      <header className="console-head">
        <div className="console-title">
          <h1>Concord</h1>
          <span>one file · many Agents · no collisions</span>
        </div>

        <form className="plan-form" onSubmit={plan}>
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="What should the Agents build?"
            aria-label="Goal"
          />
          <input
            className="plan-path"
            value={docPath}
            onChange={(e) => setDocPath(e.target.value)}
            placeholder="docs/CHANGELOG.md"
            aria-label="File"
          />
          <select
            value={pieces}
            onChange={(e) => setPieces(Number(e.target.value))}
            aria-label="How many Agents"
          >
            {[2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n} agents
              </option>
            ))}
          </select>
          <button className="button button-primary" disabled={busy === "plan" || !me}>
            {busy === "plan" ? "Planning…" : "Plan & allocate"}
          </button>
        </form>

        <div className="console-chain">
          <span className="whoami-single" title="This platform runs as one operator">
            {me ? me.displayName : "starting…"}
          </span>
          <button
            className="theme-toggle"
            title={"Theme: " + theme + " — click to cycle"}
            onClick={() =>
              setTheme((c) => (c === "light" ? "dark" : c === "dark" ? "system" : "light"))
            }
          >
            {theme === "light" ? "☀" : theme === "dark" ? "☾" : "◐"}
          </button>
          <button className="button button-ghost" onClick={onExit}>
            Playground
          </button>
        </div>
      </header>

      {error && (
        <div className="console-error" onClick={() => setError(null)} role="alert">
          {error} <span className="dismiss">dismiss</span>
        </div>
      )}
      {notice && !error && (
        <div className="console-notice" onClick={() => setNotice(null)}>
          {notice} <span className="dismiss">dismiss</span>
        </div>
      )}

      <div className="ide-main">
        <nav className="activitybar" aria-label="Panels">
          {PANELS.map((entry) => (
            <button
              key={entry.id}
              className="activity-item"
              data-active={panel === entry.id && railOpen}
              title={entry.label + " — " + entry.hint}
              onClick={() => {
                if (panel === entry.id) setRailOpen((open) => !open);
                else {
                  setPanel(entry.id);
                  setRailOpen(true);
                }
              }}
            >
              {entry.glyph}
              {badge(entry.id) > 0 && (
                <span className="activity-badge">{badge(entry.id)}</span>
              )}
            </button>
          ))}
          <span className="activity-spacer" />
        </nav>

        <div className={"console-body" + (railOpen ? "" : " rail-closed")}>
          {railOpen && (
            <aside className="rail">
              <div className="rail-label">
                <span>{PANELS.find((p) => p.id === panel)?.label}</span>
                <button className="rail-close" onClick={() => setRailOpen(false)} title="Hide">
                  ‹
                </button>
              </div>
              <p className="rail-hint">{PANELS.find((p) => p.id === panel)?.hint}</p>

              {panel === "outline" && (
                <>
                  {docs.length === 0 && (
                    <p className="panel-empty">
                      No shared document yet. Plan a task above.
                    </p>
                  )}
                  {docs.map((entry) => (
                    <div key={entry.id}>
                      <button
                        className="doc-row"
                        data-active={entry.id === selected}
                        onClick={() => {
                          setSelected(entry.id);
                          setView("editor");
                        }}
                      >
                        <span className="doc-row-name">{entry.id}</span>
                        <span className="doc-row-meta">
                          <span>rev {entry.version}</span>
                          {entry.conflicts > 0 && (
                            <span className="conflicted">{entry.conflicts} conflict</span>
                          )}
                        </span>
                      </button>
                      {entry.id === selected &&
                        allocations.map((allocation) => (
                          <button
                            key={allocation.agentId}
                            className="outline-section"
                            onClick={() => setView("live")}
                            title={"Allocated to " + allocation.agentId}
                          >
                            <i style={{ background: colorOf(allocation.agentId) }} />
                            {allocation.heading.replace(/^#+\s*/, "")}
                          </button>
                        ))}
                    </div>
                  ))}
                  <SubagentsPanel sessions={board?.sessions ?? []} />
                </>
              )}

              {panel === "queue" && (
                <QueuePanel
                  queue={board?.queue ?? []}
                  onOpenDoc={(docId) => {
                    setSelected(docId);
                    setView("editor");
                  }}
                />
              )}

              {panel === "comments" && (
                <>
                  {(review?.comments.length ?? 0) === 0 && (
                    <p className="panel-empty">
                      None yet. Select lines in the Editor to leave one — it is
                      routed to the Agent that wrote them.
                    </p>
                  )}
                  {review?.comments.map((comment) => (
                    <button
                      key={comment.id}
                      className="doc-row"
                      onClick={() => {
                        setSelection({ start: comment.startLine, end: comment.endLine });
                        setView("editor");
                      }}
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

              {panel === "usage" && <UsagePanel usage={board?.usage ?? []} />}
              {panel === "access" && (
                <AccessPanel
                  warrants={warrants}
                  busy={busy !== null}
                  onRevoke={(id) =>
                    void guard(id, async () => {
                      await api.revoke(id, "Revoked from the access panel");
                      setWarrants((await api.access()).warrants);
                    }, "Revoked. The next decision for that Agent will refuse.")
                  }
                />
              )}

              {panel === "chain" && (
                <>
                  {visibleChain.length === 0 && (
                    <p className="panel-empty">Nothing decided yet.</p>
                  )}
                  {visibleChain.map((event) => (
                    <div className="event" key={event.eventId}>
                      <div className="event-top">
                        <span className="verdict" data-decision={event.verdict.decision}>
                          {event.verdict.decision === "Allow" ? "ALLOW" : "DENY"}
                        </span>
                        <time>{clockOf(event.at)}</time>
                        <span className="event-rule">{event.verdict.ruleId}</span>
                      </div>
                      {event.verdict.decision === "Deny" && (
                        <p className="event-reason">{event.verdict.reason}</p>
                      )}
                    </div>
                  ))}
                </>
              )}
            </aside>
          )}

          <main className="stage">
            <div className="viewbar" role="tablist">
              {VIEWS.map((entry) => (
                <button
                  key={entry.id}
                  className="viewtab"
                  role="tab"
                  aria-selected={view === entry.id}
                  data-active={view === entry.id}
                  onClick={() => setView(entry.id)}
                >
                  <span className="viewtab-glyph">{entry.glyph}</span>
                  {entry.label}
                  {entry.id === "live" && anyWorking && <i className="dot-live" />}
                </button>
              ))}
              {sessions.length > 1 && (
                <select
                  className="task-picker"
                  value={session?.id ?? ""}
                  onChange={(event) => setTaskId(event.target.value)}
                  aria-label="Task"
                  title="Several tasks are planned; pick the one to work on"
                >
                  {sessions.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.title}
                    </option>
                  ))}
                </select>
              )}
              <span className="viewbar-spacer" />
              {selected && doc && (
                <span className="viewbar-doc mono">
                  {selected} · rev {doc.version}
                </span>
              )}
            </div>

            {view === "agents" && (
              <AgentBoard
                session={session}
                busy={busy !== null}
                auto={auto}
                onRun={runAgent}
                onStop={stopAgent}
                onApprove={approveAgent}
                onFocus={() => setView("live")}
                onAutorun={() =>
                  session &&
                  void guard("autorun", () => api.autorun(session.id), "Started every idle Agent.")
                }
                onIntegrate={() =>
                  session &&
                  void guard(
                    "integrate",
                    () => api.integrate(session.id),
                    "Merged. Every Agent's work is in the canonical file.",
                  )
                }
                onToggleAuto={() => setAuto((value) => !value)}
              />
            )}

            {view === "live" && (
              <Suspense fallback={<p className="panel-empty">Loading the screens…</p>}>
                <LiveScreens
                  agents={agents}
                  frames={frames}
                  activity={live}
                  theme={resolved}
                  canonicalRev={doc?.version ?? 0}
                />
              </Suspense>
            )}

            {view === "editor" && (
              <>
                {!selected || !doc ? (
                  <div className="screens-empty">
                    <h2>No document open</h2>
                    <p>Plan a task, or pick a file from Files &amp; sections.</p>
                  </div>
                ) : (
                  <>
                    <Suspense
                      fallback={<p className="panel-empty">Loading the editor…</p>}
                    >
                      <DocumentEditor
                        docId={selected}
                        content={doc.content}
                        version={doc.version}
                        blame={blame?.lines ?? null}
                        allocations={allocations}
                        theme={resolved}
                        readOnly={anyWorking}
                        onSave={saveDoc}
                        onSelect={setSelection}
                      />
                    </Suspense>

                    {selection && (
                      <ConsultConfirm
                        routing={routing}
                        range={selection}
                        question={question}
                        busy={asking}
                        onQuestion={setQuestion}
                        onAsk={ask}
                        onPick={ask}
                        onCancel={() => {
                          setSelection(null);
                          setRouting(null);
                          setQuestion("");
                        }}
                      />
                    )}

                    <div className="editor-side">
                      <ReviewPanel
                        docId={selected}
                        state={review}
                        selection={selection}
                        busy={busy !== null}
                        onRefresh={() => void refresh()}
                        onError={setError}
                        onClearSelection={() => setSelection(null)}
                      />

                      {consultations.length > 0 && (
                        <div className="consults">
                          <div className="review-head">
                            <b>Consultations</b>
                            <span className="review-count">
                              explanation only — the revision never moves
                            </span>
                          </div>
                          {consultations.slice(0, 5).map((item) => (
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

                      {openConflicts.map((conflict) => (
                        <div className="conflict" key={conflict.id}>
                          <div className="conflict-head">
                            <b>Conflict detected — canonical code was not overwritten</b>
                            <span>
                              {shortId(conflict.agentId)} wrote against rev{" "}
                              {conflict.atVersion} · {clockOf(conflict.at)}
                            </span>
                          </div>
                          <div className="conflict-sides">
                            <Side
                              label="theirs · committed"
                              text={conflict.theirs}
                              marked={conflict.conflicts.flatMap((r) => r.theirs)}
                            />
                            <Side
                              label="ours · the Agent's attempt"
                              text={conflict.ours}
                              marked={conflict.conflicts.flatMap((r) => r.ours)}
                            />
                          </div>
                          <div className="conflict-actions">
                            <button onClick={() => resolveConflict(conflict.id, "theirs")}>
                              Keep theirs
                            </button>
                            <button onClick={() => resolveConflict(conflict.id, "ours")}>
                              Keep ours
                            </button>
                            <button onClick={() => resolveConflict(conflict.id, "both")}>
                              Keep both
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </main>
        </div>
      </div>

      <div className="panel">
        <div className="panel-tabs">
          {(["live", "problems", "chain"] as const).map((tab) => (
            <button
              key={tab}
              className="panel-tab"
              data-active={bottomTab === tab}
              onClick={() => {
                setBottomTab(tab);
                setBottomOpen(true);
              }}
            >
              {tab === "live" ? "Agent Live" : tab === "problems" ? "Problems" : "Decision chain"}
              {tab === "problems" && denials.length + openConflicts.length > 0 && (
                <span className="chain-seq bad">{denials.length + openConflicts.length}</span>
              )}
              {tab === "chain" && <span className="chain-seq">{chain?.events.length ?? 0}</span>}
            </button>
          ))}
          <span className="panel-spacer" />
          <button className="panel-tab" onClick={() => setBottomOpen((o) => !o)}>
            {bottomOpen ? "collapse ⌄" : "expand ⌃"}
          </button>
        </div>

        <div className="panel-body" data-open={bottomOpen}>
          {bottomTab === "live" && (
            <AgentLive events={live} connected={streaming && me !== null} />
          )}

          {bottomTab === "problems" && (
            <>
              {denials.length === 0 && openConflicts.length === 0 && (
                <p className="panel-empty">
                  Nothing refused and nothing contested. This fills up when the
                  middleware says no.
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

          {bottomTab === "chain" && (
            <>
              {(chain?.events.length ?? 0) === 0 && (
                <p className="panel-empty">Nothing decided yet.</p>
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
        </div>
      </div>

      <footer className="statusbar">
        <span>{me ? <b>{me.displayName}</b> : "starting…"}</span>
        <span>{session ? session.title : "no task"}</span>
        <span>
          {agents.filter((a) => a.state === "in_progress").length} of {agents.length} working
        </span>
        <span className={openConflicts.length > 0 ? "bad" : ""}>
          {openConflicts.length} conflict{openConflicts.length === 1 ? "" : "s"}
        </span>
        <span className={openComments > 0 ? "bad" : ""}>
          {openComments} open comment{openComments === 1 ? "" : "s"}
        </span>
        <span className="statusbar-spacer" />
        <span className={streaming ? "ok" : ""}>{streaming ? "live" : "polling"}</span>
        {chain && (
          <span className={chain.chainValid ? "ok" : "bad"}>
            chain {chain.chainValid ? "VALID" : "BROKEN"}
          </span>
        )}
        {doc && <span>rev {doc.version}</span>}
      </footer>
    </div>
  );
}
