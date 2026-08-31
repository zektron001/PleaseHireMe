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
import type {
  AgentRouting,
  SectionAllocation,
  SessionAgent,
  WorkspaceFrame,
} from "./types";
import { type Selection } from "./Code";
import { CodeEditor, type SaveOutcome } from "./editor/CodeEditor";
import { AgentBoard, ConsultConfirm } from "./Agents";
import { LiveScreens } from "./Screens";
import {
  AccessPanel,
  AgentLive,
  PeoplePanel,
  QueuePanel,
  SubagentsPanel,
  UsagePanel,
} from "./Collab";
import { Sessions } from "./Sessions";
import { ExplorerView } from "./views/ExplorerView";
import { AgentsView } from "./views/AgentsView";
import { AgentChat } from "./views/AgentChat";
import { CreateAgentDialog } from "./views/CreateAgentDialog";
import { ShareDialog } from "./views/ShareDialog";
import { SharedWithMe } from "./views/SharedWithMe";
import { Tour } from "./onboarding/Tour";
import { useTour } from "./onboarding/useTour";
import { useAgents } from "./state/useAgents";
import { SourceControlView } from "./views/SourceControlView";
import { clockOf, colorOf, humanName, initialsOf, shortId } from "./participants";
import {
  applyTheme,
  readChoice,
  resolve as resolveTheme,
  watchSystem,
  type ThemeChoice,
} from "./theme";
import { Codicon } from "./shell/Codicon";
import { Sash } from "./shell/Sash";
import { TitleBar, type Menu } from "./shell/TitleBar";
import { StatusBar, type StatusItem } from "./shell/StatusBar";
import { CommandPalette } from "./shell/CommandPalette";
import { matchKey, type Command } from "./shell/commands";
import { Guide } from "./onboarding/Guide";
import "./onboarding/guide.css";
import "./console.css";
import "./workbench.css";

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
  | "access"
  | "scm"
  | "agents";

/**
 * The activity bar. Codicon names, not emoji: these are the icons VS Code
 * itself ships, so the rail reads as the real thing at a glance and the labels
 * stay in the tooltip where VS Code puts them.
 */
type BottomTab = "live" | "decisions" | "chain" | "problems" | "output";

const BOTTOM_TABS: { id: BottomTab; label: string }[] = [
  { id: "live", label: "Agent Live" },
  { id: "problems", label: "Problems" },
  { id: "output", label: "Output" },
  { id: "decisions", label: "Decisions" },
  { id: "chain", label: "Decision chain" },
];

const LAYOUT_KEY = "launchpad.layout";

/**
 * Layout sizes live in CSS custom properties so a sash drag never re-renders
 * the workbench (see Sash.tsx). They are read back out here only to persist
 * them, which is why this is a plain function and not state.
 */
function rememberLayout(next: { sidebar?: number; panel?: number }): void {
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as Record<
      string,
      number
    >;
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...stored, ...next }));
  } catch {
    // Private windows and blocked site data both throw. The layout still works,
    // it just will not survive a reload.
  }
}

function restoreLayout(): void {
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as Record<
      string,
      number
    >;
    if (stored["sidebar"]) {
      document.documentElement.style.setProperty("--sidebar-width", stored["sidebar"] + "px");
    }
    if (stored["panel"]) {
      document.documentElement.style.setProperty("--panel-height", stored["panel"] + "px");
    }
  } catch {
    // Same as above: the defaults in workbench.css apply.
  }
}

const PANELS: { id: Panel; icon: string; label: string; key?: string }[] = [
  { id: "files", icon: "files", label: "Explorer", key: "ctrl+shift+e" },
  { id: "sessions", icon: "play-circle", label: "Sessions", key: "ctrl+shift+d" },
  { id: "scm", icon: "source-control", label: "Source Control", key: "ctrl+shift+g" },
  { id: "agents", icon: "organization", label: "Agents", key: "ctrl+shift+y" },
  { id: "comments", icon: "comment-discussion", label: "Comments" },
  { id: "people", icon: "account", label: "People" },
  { id: "queue", icon: "list-ordered", label: "Queue" },
  { id: "subagents", icon: "type-hierarchy-sub", label: "Subagents" },
  { id: "usage", icon: "graph", label: "Usage" },
  { id: "access", icon: "key", label: "Share & access" },
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
  const [view, setView] = useState<
    "dashboard" | "workspace" | "chat" | "orchestration" | "screens"
  >("dashboard");
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [sharing, setSharing] = useState(false);
  const tour = useTour();

  const [review, setReview] = useState<ReviewState | null>(null);
  const [blame, setBlame] = useState<BlameView | null>(null);
  const [showBlame, setShowBlame] = useState(true);
  const [theme, setTheme] = useState<ThemeChoice>(() => readChoice());
  const [panel, setPanel] = useState<Panel>("files");
  const [guideOff, setGuideOff] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTab>("live");
  const [bottomOpen, setBottomOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [palette, setPalette] = useState<{ open: boolean; mode: ">" | "" }>({
    open: false,
    mode: ">",
  });
  const [selection, setSelection] = useState<Selection | null>(null);
  /** Which Agent owns which heading, so the editor can band the document. */
  const [allocations, setAllocations] = useState<SectionAllocation[]>([]);
  const [routing, setRouting] = useState<AgentRouting | null>(null);
  const [frames, setFrames] = useState<WorkspaceFrame[]>([]);
  /** Auto mode starts every idle Agent as soon as the board says one is. */
  const [auto, setAuto] = useState(false);
  const [anchorLine, setAnchorLine] = useState<number | null>(null);
  const [question, setQuestion] = useState("");
  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [asking, setAsking] = useState(false);

  // `enabled` keeps the workbench from polling /api/agents for someone who
  // never opens the Agents view.
  const playground = useAgents(panel === "agents" || view === "chat");


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
      .then((result) => {
        // The try-it flow reads better with two principals, not three: one
        // human who delegates, and you. The authorization story is unchanged -
        // the operator still cannot run the Agent that acts for someone else.
        const operator = result.humans.filter((h) => h.handle === "orchestrator");
        const others = result.humans.filter((h) => h.handle !== "orchestrator");
        const delegate = others.find((h) => h.handle === "bob") ?? others[0];
        setHumans([...(delegate ? [delegate] : []), ...operator]);
      })
      .catch(() => setHumans([]));
  }, []);

  // Monaco cannot read CSS custom properties, so it needs the RESOLVED theme,
  // not the choice. "system" has to re-resolve when the OS flips.
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    resolveTheme(readChoice()),
  );

  useEffect(() => {
    setResolvedTheme(applyTheme(theme));
    // Only follow the OS while the choice actually is "follow the OS".
    if (theme !== "system") return;
    return watchSystem(() => setResolvedTheme(applyTheme("system")));
  }, [theme]);

  const signIn = useCallback(async (human: Human) => {
    try {
      const result = await api.signIn(human.handle);
      setSessionToken(result.token);
      setMe(result.human);
      // Land where the first action is, not on an Explorer with nothing in it.
      setPanel("sessions");
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
    // A second stream, because a workspace frame carries a WHOLE FILE.
    // Interleaving them with the one-line rows a human reads would push real
    // events off the board within a couple of turns.
    const closeFrames = api.workspaceStream((frame) => {
      setFrames((current) => [
        frame,
        ...current.filter(
          (other) => other.agentId !== frame.agentId || other.docId !== frame.docId,
        ),
      ]);
    });
    return () => {
      closeStream.current?.();
      closeStream.current = null;
      closeFrames();
      setStreaming(false);
    };
  }, [me]);

  /**
   * Auto mode. Starts anything idle each time the board reports it, which is
   * the same route the Run all button uses - "auto" describes who pressed
   * start, not what runs.
   */
  useEffect(() => {
    if (!auto || busy) return;
    const current = board?.sessions.find((entry) => entry.id === session);
    if (!current || current.running > 0) return;
    // `assigned` alone is not "idle, needs work": a finished turn resets to it,
    // so auto mode would restart the same Agent forever and the task would
    // never come to rest. One turn per Agent; after that the owner approves.
    const idle = (agent: SessionAgent): boolean =>
      agent.mine && agent.state === "assigned" && agent.turns === 0;
    if (!current.agents.some(idle)) return;
    // Peer feedback before fresh work, and this order is what keeps the
    // one-run-per-Agent 409 from firing: an Agent that just took a
    // re-iteration is no longer idle, so it does not also get a plain turn.
    void (async () => {
      const sent = await api
        .autoReiterate(current.id)
        .catch(() => ({ runs: [] as unknown[] }));
      if (sent.runs.length === 0) await api.autorun(current.id).catch(() => undefined);
    })();
  }, [auto, board, session, busy]);

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
      // The live screens' fallback. The pushed stream below is the fast path;
      // this keeps the panes right if it drops.
      void api
        .workspaces()
        .then((result) => {
          if (result.frames.length > 0) {
            setFrames((current) => (current.length === 0 ? result.frames : current));
          }
        })
        .catch(() => undefined);
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
        setAllocations(
          await api.sections(target, myAgent).then((r) => r.allocations).catch(() => []),
        );
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

  /**
   * The human write path the editor seam was left open for.
   *
   * PUT, not the Agent write route EDITOR_SEAM.md names, and the reason is
   * section allocation: writing as `myAgent` would put the human inside that
   * Agent's allocated heading and CONCORD would refuse every line outside it.
   * The human owns the whole file. `writeAsHuman` takes no warrant (a warrant
   * is a delegation FROM this human), ignores allocations, and does not merge -
   * an interactive edit either applies to the revision you were looking at or
   * you are told it moved. There is still exactly one Agent write path; this is
   * simply not one.
   */
  const saveDoc = useCallback(
    async (content: string, expectedVersion: number): Promise<SaveOutcome> => {
      if (!selected) return { status: "denied", reason: "No document open" };
      try {
        const { outcome } = await api.saveDoc(selected, {
          expectedVersion,
          content,
          message: "edited by hand",
        });
        void refresh();
        if (outcome.status === "written") {
          return {
            status: "written",
            version: outcome.version ?? expectedVersion + 1,
            content: outcome.content ?? content,
          };
        }
        return { status: "denied", reason: "The document moved - reopen it" };
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 409) {
          return { status: "denied", reason: "The document moved - reopen it" };
        }
        return {
          status: "denied",
          reason: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
    [selected, refresh],
  );

  const stopSubtask = (agent: SessionAgent) =>
    void guardAction("stop:" + agent.subtaskId, () => api.stopSubtask(agent.subtaskId));
  // Approving is two server steps: the Agent proposes the merge (which the PDP
  // checks against its warrant) and then the owner approves it. The owner
  // pressing one button is still both decisions, and both land in the chain.
  const approveSubtask = (agent: SessionAgent) =>
    void guardAction("approve:" + agent.subtaskId, async () => {
      await api.submit(agent.subtaskId);
      await api.approve(agent.subtaskId);
    });
  const runAgent = (agent: SessionAgent) =>
    void guardAction("run:" + agent.subtaskId, () =>
      api.runSubtask(
        agent.subtaskId,
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

  /** Runs an action, surfaces whatever the middleware said, and refreshes. */
  const guardAction = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  /**
   * Who wrote the selected lines. Selecting them already tells the platform,
   * so asking a human to retype an Agent id was making them do the platform's
   * job - and getting it wrong returned a 400.
   */
  const lastRouted = useRef("");
  useEffect(() => {
    if (!selection || !selected || !myAgent) {
      setRouting(null);
      return;
    }
    const key = selected + ":" + selection.start + ":" + selection.end;
    if (key === lastRouted.current) return;
    lastRouted.current = key;
    void api
      .routeFor(selected, myAgent, selection.start, selection.end)
      .then(setRouting)
      .catch(() => setRouting(null));
  }, [selection, selected, myAgent]);

  const ask = async (targetAgentId?: string) => {
    if (!selected || !myAgent || !selection || !question.trim()) return;
    setAsking(true);
    try {
      await api.consult({
        docId: selected,
        agentId: myAgent,
        ...(targetAgentId ? { targetAgentId } : {}),
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

  /**
   * Every action in the workbench, in one list. Buttons call into this rather
   * than the other way round, which is what makes the palette worth having:
   * the keyboard reaches everything the mouse can, and a new action is one
   * object rather than an edit in three places.
   */
  const commands = useMemo<Command[]>(() => {
    const showPanel = (id: Panel, label: string, key?: string): Command => ({
      id: "view.show." + id,
      title: "Show " + label,
      category: "View",
      key,
      run: () => {
        setPanel(id);
        setSidebarOpen(true);
      },
    });

    const list: Command[] = [
      {
        id: "workbench.showCommands",
        title: "Show All Commands",
        category: "Workbench",
        key: "ctrl+shift+p",
        hidden: true,
        run: () => setPalette({ open: true, mode: ">" }),
      },
      {
        id: "workbench.quickOpen",
        title: "Go to File...",
        category: "Go",
        key: "ctrl+p",
        run: () => setPalette({ open: true, mode: "" }),
      },
      {
        id: "workbench.toggleSidebar",
        title: "Toggle Primary Side Bar",
        category: "View",
        key: "ctrl+b",
        run: () => setSidebarOpen((open) => !open),
      },
      {
        id: "workbench.togglePanel",
        title: "Toggle Panel",
        category: "View",
        key: "ctrl+j",
        run: () => setBottomOpen((open) => !open),
      },
      ...PANELS.map((entry) => showPanel(entry.id, entry.label, entry.key)),
      {
        id: "view.problems",
        title: "Problems",
        category: "View",
        key: "ctrl+shift+m",
        run: () => {
          setBottomTab("problems");
          setBottomOpen(true);
        },
      },
      {
        id: "view.agentLive",
        title: "Agent Live",
        category: "View",
        run: () => {
          setBottomTab("live");
          setBottomOpen(true);
        },
      },
      {
        id: "workbench.closeEditor",
        title: "Close Editor",
        category: "View",
        key: "ctrl+w",
        enabled: selected !== null,
        run: () => {
          if (!selected) return;
          setOpenTabs((tabs) => tabs.filter((id) => id !== selected));
          setSelected(openTabs.find((id) => id !== selected) ?? null);
        },
      },
      {
        id: "workbench.selectTheme",
        title: "Cycle Colour Theme",
        category: "Preferences",
        run: () =>
          setTheme((current) =>
            current === "light" ? "dark" : current === "dark" ? "system" : "light",
          ),
      },
      {
        id: "concord.toggleBlame",
        title: showBlame ? "Hide Line Attribution" : "Show Line Attribution",
        category: "CONCORD",
        enabled: doc !== null,
        run: () => setShowBlame((on) => !on),
      },
      {
        id: "warrant.plan",
        title: "Plan a Task and Fan Out",
        category: "WARRANT",
        enabled: me !== null,
        run: () => {
          setPanel("sessions");
          setSidebarOpen(true);
          setView("dashboard");
        },
      },
      {
        id: "workbench.sessions",
        title: "Go to Sessions Dashboard",
        category: "Go",
        run: () => setView("dashboard"),
      },
      {
        id: "workbench.orchestration",
        title: "Go to Agents on This Task",
        category: "Go",
        run: () => setView("orchestration"),
      },
      {
        id: "workbench.screens",
        title: "Go to Live Screens",
        category: "Go",
        run: () => setView("screens"),
      },
      {
        id: "task.runAll",
        title: "Run All Idle Agents",
        category: "Agent",
        run: () => {
          const current = board?.sessions.find((entry) => entry.id === session);
          if (current) void guardAction("autorun", () => api.autorun(current.id));
        },
      },
      {
        id: "task.merge",
        title: "Merge All Work Into the Canonical File",
        category: "Agent",
        run: () => {
          const current = board?.sessions.find((entry) => entry.id === session);
          if (current) void guardAction("integrate", () => api.integrate(current.id));
        },
      },
      {
        id: "agents.create",
        title: "Create Agent",
        category: "Agent",
        run: () => setShowCreateAgent(true),
      },
      {
        id: "agents.chat",
        title: "Open Agent Chat",
        category: "Agent",
        enabled: playground.selectedId !== null,
        run: () => setView("chat"),
      },
      {
        id: "agents.toggle",
        title: "Start / Stop Agent",
        category: "Agent",
        enabled: playground.selected !== null,
        run: () => void playground.toggleAgent(),
      },
      {
        id: "workbench.playground",
        title: "Open the Classic Playground",
        category: "Go",
        run: onExit,
      },
    ];

    for (const subtask of task?.subtasks ?? []) {
      list.push({
        id: "warrant.run." + subtask.id,
        title: "Run Agent for " + subtask.title,
        category: "WARRANT",
        enabled: subtask.ownerId === me?.id && busy === null,
        run: () => void runSubtask(subtask),
      });
    }

    return list;
    // `runSubtask` is re-created every render, so listing it here would rebuild
    // the array every render and re-subscribe the key listener with it. What it
    // actually closes over is `shared`, which is listed instead.
  }, [
    selected,
    openTabs,
    showBlame,
    doc,
    me,
    task,
    busy,
    shared,
    onExit,
    playground.selectedId,
    playground.selected,
  ]);

  // One listener for the whole workbench. preventDefault only on a real match,
  // so Ctrl+C and friends still belong to the browser.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPalette((current) => (current.open ? { ...current, open: false } : current));
        return;
      }
      for (const command of commands) {
        if (!command.key || !matchKey(event, command.key)) continue;
        if (command.enabled === false) return;
        event.preventDefault();
        void command.run();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commands]);

  useEffect(restoreLayout, []);

  const statusLeft = useMemo<StatusItem[]>(() => {
    const items: StatusItem[] = [
      {
        id: "who",
        icon: me ? "account" : "circle-slash",
        text: me ? me.displayName : "not signed in",
        title: me?.id,
        tone: "remote",
      },
      {
        id: "capability",
        icon: "shield",
        text: capability,
        title: "Read from your live warrant's scopes, not from a setting",
      },
    ];
    if (selected) {
      items.push({
        id: "doc",
        icon: "file",
        text: selected.split("/").at(-1) ?? selected,
        title: selected,
      });
    }
    if (doc) items.push({ id: "rev", icon: "git-commit", text: "rev " + doc.version });
    return items;
  }, [me, capability, selected, doc]);

  const statusRight = useMemo<StatusItem[]>(
    () => [
      {
        id: "problems",
        icon: "error",
        text: openConflicts.length + " conflict" + (openConflicts.length === 1 ? "" : "s"),
        tone: openConflicts.length > 0 ? "warn" : undefined,
        onClick: () => {
          setBottomTab("problems");
          setBottomOpen(true);
        },
      },
      {
        id: "comments",
        icon: "comment",
        text: openReviewCount,
        title: "Open review comments",
        onClick: () => {
          setPanel("comments");
          setSidebarOpen(true);
        },
      },
      {
        id: "stream",
        icon: streaming ? "radio-tower" : "sync",
        text: streaming ? "live" : "polling",
        title: streaming
          ? "Pushed over SSE"
          : "The board poll carries the same events, two seconds behind",
      },
      {
        id: "chain",
        icon: chain?.chainValid === false ? "unlock" : "lock",
        text: chain ? "chain " + (chain.chainValid ? "VALID" : "BROKEN") : "chain —",
        tone: chain && !chain.chainValid ? "error" : undefined,
        onClick: () => {
          setBottomTab("chain");
          setBottomOpen(true);
        },
      },
    ],
    [openConflicts.length, openReviewCount, streaming, chain],
  );

  const menus = useMemo<Menu[]>(() => {
    const find = (id: string) => commands.find((entry) => entry.id === id);
    const pick = (...ids: string[]) =>
      ids.map(find).filter((entry): entry is Command => entry !== undefined);
    return [
      { label: "File", items: pick("workbench.quickOpen", "workbench.closeEditor") },
      { label: "View", items: pick("workbench.showCommands", "workbench.toggleSidebar", "workbench.togglePanel", "view.problems", "view.agentLive") },
      { label: "Go", items: pick("workbench.quickOpen", "workbench.sessions", "workbench.playground") },
      {
        label: "Agent",
        items: pick("agents.create", "agents.chat", "agents.toggle", "warrant.plan", "concord.toggleBlame"),
      },
      { label: "Preferences", items: pick("workbench.selectTheme") },
    ];
  }, [commands]);

  const badge = (id: Panel): number | null => {
    if (id === "sessions") return board?.sessions.length ?? null;
    if (id === "scm") return openConflicts.length || null;
    if (id === "agents") return playground.agents.length || null;
    if (id === "files") return docs.length || null;
    if (id === "people") return board?.people.filter((p) => p.agents.length > 0).length ?? null;
    if (id === "queue") return board?.queue.length || null;
    if (id === "comments") return openReviewCount || null;
    if (id === "usage") return board?.usage.length || null;
    if (id === "access") return warrants.filter((w) => w.live).length || null;
    return null;
  };

  /**
   * The tour spotlights real chrome, which means the chrome has to be on
   * screen before the step arrives. The sidebar is one element that answers
   * to three different `data-tour` ids depending on which panel is showing,
   * so "reveal the Explorer" is genuinely `setPanel("files")` and not a
   * scroll. Memoized because <Tour> has this in an effect's dependency list -
   * which is also why the document list is read through a ref instead of
   * closed over: a new identity on every docs refresh would re-fire the reveal.
   */
  const tourLatest = useRef({ docs, openTabs });
  tourLatest.current = { docs, openTabs };

  const revealForTour = useCallback((target: string) => {
    if (target === "explorer" || target === "agents" || target === "access") {
      setPanel(target === "explorer" ? "files" : target);
      setSidebarOpen(true);
      return;
    }
    // The tab strip only exists once something is open, and on a genuine first
    // run nothing is - the step would spotlight nothing and fall back to a
    // centered card. Opening the first document is the honest fix: the step is
    // about tabs, so there had better be a tab.
    if (target === "tabstrip" || target === "editor") {
      const { docs: known, openTabs: tabs } = tourLatest.current;
      const first = known[0]?.id;
      if (tabs.length === 0 && first) {
        setSelected(first);
        setOpenTabs([first]);
        setView("workspace");
      }
      return;
    }
    if (target === "activitybar") {
      setSidebarOpen(true);
      return;
    }
    if (target === "panel" || target === "panel-tabs") {
      setBottomOpen(true);
    }
  }, []);

  /**
   * The view switcher. Hoisted out of the editor branch on purpose: it used to
   * live inside it, so picking any other view unmounted the only way back and
   * you had to reopen a document from the Explorer to get the strip again.
   */
  const tabStrip = openTabs.length > 0 ? (

                <div className="tabstrip" data-tour="tabstrip">
                  <button
                    className="tab tab-back"
                    onClick={() => setView("dashboard")}
                    data-active={view === "dashboard"}
                    title="Back to sessions"
                  >
                    ▦
                  </button>
                  <button
                    className="tab tab-back"
                    onClick={() => setView("orchestration")}
                    data-active={view === "orchestration"}
                    title="Agents on this task - run, stop, approve, merge"
                  >
                    ◈
                  </button>
                  <button
                    className="tab tab-back"
                    onClick={() => setView("screens")}
                    data-guide="view-screens"
                    data-active={view === "screens"}
                    title="Live screens - each Agent's own workspace copy"
                  >
                    ▶
                  </button>
                  {openTabs.map((tabId) => {
                    const entry = docs.find((item) => item.id === tabId);
                    return (
                      <button
                        key={tabId}
                        className="tab"
                        data-active={tabId === selected}
                        onClick={() => { setSelected(tabId); setView("workspace"); }}
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
  ) : null;

  return (
    <div
      className="workbench"
      data-sidebar={sidebarOpen ? "open" : "closed"}
      data-panel={bottomOpen ? "open" : "closed"}
    >
      <TitleBar
        menus={menus}
        humans={humans}
        me={me}
        onSignIn={(human) => void signIn(human)}
        onQuickOpen={() => setPalette({ open: true, mode: "" })}
        onShare={() => setSharing(true)}
        shareTarget={selected}
        onTour={() => tour.start()}
        theme={theme}
        onCycleTheme={() =>
          setTheme((current) =>
            current === "light" ? "dark" : current === "dark" ? "system" : "light",
          )
        }
        sidebarOpen={sidebarOpen}
        panelOpen={bottomOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onTogglePanel={() => setBottomOpen((open) => !open)}
      />

      <CommandPalette
        open={palette.open}
        initialMode={palette.mode}
        commands={commands}
        docs={docs.map((entry) => ({ id: entry.id, version: entry.version }))}
        onOpenDoc={(docId) => {
          setSelected(docId);
          setView("workspace");
        }}
        onClose={() => setPalette((current) => ({ ...current, open: false }))}
      />

      <ShareDialog
        open={sharing}
        docId={selected}
        viewerId={me?.id ?? null}
        onClose={() => setSharing(false)}
        // A new grant is a new warrant, so the Access panel is stale the
        // instant one is made. Refetch rather than patch the list locally:
        // the server is the only place the live set is actually known.
        onChanged={() => {
          void api
            .access()
            .then((result) => setWarrants(result.warrants))
            .catch(() => undefined);
        }}
      />

      {/* Last of the overlays, so its spotlight sits above the dialogs as
          well as the workbench. */}
      <Tour open={tour.open} onClose={tour.stop} onReveal={revealForTour} />

      <CreateAgentDialog
        open={showCreateAgent}
        busy={playground.busy}
        onCreate={playground.createAgent}
        onClose={() => setShowCreateAgent(false)}
      />

      {(error || playground.error) && (
        <div className="console-error">{error ?? playground.error}</div>
      )}

      <nav className="activitybar" data-tour="activitybar">
        {PANELS.map((entry) => {
          const count = badge(entry.id);
          return (
            <button
              key={entry.id}
              data-active={panel === entry.id}
              title={entry.label + (entry.key ? " (" + entry.key + ")" : "")}
              onClick={() => {
                setPanel(entry.id);
                setSidebarOpen(true);
                if (entry.id === "sessions") setView("dashboard");
              }}
            >
              <Codicon name={entry.icon} />
              {count !== null && count > 0 && (
                <span className="activity-badge">{count}</span>
              )}
            </button>
          );
        })}
        <span className="activity-spacer" />
      </nav>

      <aside
        className="sidebar"
        data-tour={panel === "files" ? "explorer" : panel}
      >
        <div className="sidebar-head">
          <span>{PANELS.find((entry) => entry.id === panel)?.label}</span>
          <span>{badge(panel) ?? ""}</span>
        </div>

        <div className="sidebar-body">
          {/* Agents is the starter kit's own Agent model, which is gated
              by the shared token rather than a human session - so it is the one
              view that works signed out, and must not claim otherwise. */}
          {!me && panel !== "agents" && (
            <p className="panel-empty">
              Sign in from the title bar. Every view here is scoped to the
              delegations you actually hold.
            </p>
          )}

          {me && panel === "sessions" && (
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
          <button className="button button-primary" data-guide="split-it" disabled={busy === "plan"}>
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
          )}

            {me && panel === "sessions" && (
              <>
                {(board?.sessions ?? []).map((entry) => (
                  <button
                    key={entry.id}
                    data-guide="explorer-doc"
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
              <ExplorerView
                docs={docs}
                selected={selected}
                onOpen={(docId) => {
                  setSelected(docId);
                  setView("workspace");
                }}
              />
            )}

            {panel === "agents" && (
              <AgentsView
                agents={playground.agents}
                selectedId={playground.selectedId}
                system={playground.system}
                busy={playground.busy}
                onSelect={(id) => {
                  playground.setSelectedId(id);
                  setView("chat");
                }}
                onCreate={() => setShowCreateAgent(true)}
                onToggle={() => void playground.toggleAgent()}
                onDelete={() => void playground.deleteAgent()}
              />
            )}

            {me && panel === "scm" && (
              <SourceControlView
                docId={selected}
                agentId={myAgent}
                version={doc?.version ?? 0}
                conflicts={openConflicts}
                onOpenProblems={() => {
                  setBottomTab("problems");
                  setBottomOpen(true);
                }}
              />
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
              <>
                {/* Above the warrant list on purpose: a share you have not
                    armed yet is the one thing here that needs an action. */}
                <SharedWithMe
                  onOpenDoc={(docId) => {
                    setSelected(docId);
                    setOpenTabs((tabs) => (tabs.includes(docId) ? tabs : [...tabs, docId]));
                    setView("workspace");
                  }}
                  onChanged={() => {
                    void api
                      .access()
                      .then((result) => setWarrants(result.warrants))
                      .catch(() => undefined);
                  }}
                />
                <AccessPanel
                  warrants={warrants}
                  busy={busy !== null}
                  onRevoke={(id) => void revoke(id)}
                />
              </>
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

        <Sash
          orientation="vertical"
          variable="--sidebar-width"
          min={170}
          max={600}
          onCommit={(value) => rememberLayout({ sidebar: value })}
        />
      </aside>

      <main className="editor-area" data-tour="editor" data-guide="editor-surface">
          <div className="doc">
            {tabStrip}
            {view === "chat" ? (
              playground.selected ? (
                <AgentChat
                  agent={playground.selected}
                  messages={playground.messages}
                  activeRun={playground.activeRun}
                  system={playground.system}
                  onSend={playground.sendMessage}
                />
              ) : (
                <div className="editor-empty">
                  <p>No Agent selected.</p>
                  <p>
                    Create one from Run and Debug, or press <kbd>Ctrl+Shift+P</kbd>.
                  </p>
                </div>
              )
            ) : view === "orchestration" ? (
              <AgentBoard
                session={board?.sessions.find((entry) => entry.id === session) ?? null}
                busy={busy !== null}
                auto={auto}
                onRun={runAgent}
                onStop={stopSubtask}
                onApprove={approveSubtask}
                onFocus={() => setView("screens")}
                onAutorun={() => {
                  const current = board?.sessions.find((entry) => entry.id === session);
                  if (current) void guardAction("autorun", () => api.autorun(current.id));
                }}
                onIntegrate={() => {
                  const current = board?.sessions.find((entry) => entry.id === session);
                  if (!current) return;
                  // Merging is the end of the task, so land on the thing it
                  // produced - the shared file, open and editable - rather than
                  // leaving the operator on a board with nothing left to do.
                  void guardAction("integrate", () => api.integrate(current.id)).then(() => {
                    const merged = current.docs[0]?.id;
                    if (merged) {
                      setSelected(merged);
                      setOpenTabs((tabs) =>
                        tabs.includes(merged) ? tabs : [...tabs, merged],
                      );
                    }
                    setView("workspace");
                  });
                }}
                onToggleAuto={() => setAuto((value) => !value)}
              />
            ) : view === "screens" ? (
              <LiveScreens
                agents={board?.sessions.find((entry) => entry.id === session)?.agents ?? []}
                frames={frames}
                activity={live}
                theme={resolvedTheme}
                canonicalRev={doc?.version ?? 0}
              />
            ) : view === "dashboard" ? (
              <Sessions
                sessions={board?.sessions ?? []}
                activeId={session}
                viewer={me?.id ?? null}
                onOpen={(entry) => {
                  setSession(entry.id);
                  const first = entry.docs[0]?.id;
                  if (first) setSelected(first);
                  // Into the Agents board, not straight at the file: the first
                  // question about a session is who is on it and what they own.
                  setView("orchestration");
                }}
              />
            ) : (
              <>

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

                    <CodeEditor
                      docId={selected}
                      value={doc.content ?? ""}
                      version={doc.version}
                      theme={resolvedTheme}
                      readOnly={false}
                      blame={blame?.lines ?? null}
                      showBlame={showBlame}
                      present={doc.present?.present ?? []}
                      viewerAgentId={myAgent}
                      comments={review?.comments ?? []}
                      conflicts={doc.conflicts ?? []}
                      onSelect={setSelection}
                      onRequestSave={saveDoc}
                    />

                    {selection && (
                      <ConsultConfirm
                        routing={routing}
                        range={selection}
                        question={question}
                        busy={asking}
                        onQuestion={setQuestion}
                        onAsk={(agentId) => void ask(agentId)}
                        onPick={(agentId) => void ask(agentId)}
                        onCancel={() => {
                          setSelection(null);
                          setRouting(null);
                          setQuestion("");
                        }}
                      />
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

      </main>

      <div className="panel" data-tour="panel">
        <Sash
          orientation="horizontal"
          variable="--panel-height"
          min={35}
          max={700}
          invert
          onCommit={(value) => rememberLayout({ panel: value })}
        />
        <div className="panel-head">
          <div className="panel-tabs" data-tour="panel-tabs">
            {BOTTOM_TABS.map((tab) => {
              const count =
                tab.id === "chain"
                  ? (chain?.events.length ?? 0)
                  : tab.id === "problems"
                    ? denials.length + openConflicts.length
                    : tab.id === "live"
                      ? live.length
                      : 0;
              return (
                <button
                  key={tab.id}
                  className="panel-tab"
                  data-active={bottomTab === tab.id}
                  onClick={() => {
                    setBottomTab(tab.id);
                    setBottomOpen(true);
                  }}
                >
                  {tab.label}
                  {count > 0 && <span className="activity-badge">{count}</span>}
                </button>
              );
            })}
          </div>
          <button
            className="icon-button"
            onClick={() => setBottomOpen((open) => !open)}
            title={bottomOpen ? "Collapse Panel (Ctrl+J)" : "Expand Panel (Ctrl+J)"}
          >
            <Codicon name={bottomOpen ? "chevron-down" : "chevron-up"} />
          </button>
        </div>

        <div className="panel-body" data-open={bottomOpen}>
          {bottomTab === "live" && (
            <AgentLive events={live} connected={streaming && me !== null} />
          )}

          {bottomTab === "decisions" && (
            <>
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
            </>
          )}

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

      <StatusBar left={statusLeft} right={statusRight} />

      <Guide
        state={{
          me,
          humans,
          session: activeSession,
          view,
          panel,
          hasOpenDoc: Boolean(selected) && view === "workspace",
          merged: activeSession?.state === "integrated",
        }}
        dismissed={guideOff}
        onDismiss={() => setGuideOff(true)}
      />
    </div>
  );
}
