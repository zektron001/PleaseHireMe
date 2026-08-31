/**
 * The live screens: one pane per Agent, showing that Agent's own copy of the
 * file as it stands on disk right now.
 *
 * This is the answer to "show me the AI coding live", and the reason it is not
 * theatre: during a turn the Agent runs real commands, its workspace copy really
 * changes, and the server polls that file and pushes each new state. Text that
 * appears here appeared in the file, at that moment, because the Agent put it
 * there.
 *
 * What the screens also have to show is the harder half of the pitch: that
 * these Agents are not working blind next to each other. Three things carry it,
 * and each is a fact the backend actually holds -
 *
 *   the band       the section CONCORD confines this Agent to. Lines outside
 *                  it are dimmed, because they are not this Agent's to change.
 *   the flash      the region that just changed, from a real diff of two file
 *                  states. It fades; it does not loop.
 *   the ledger     what every OTHER Agent has committed to canonical state, so
 *                  each pane shows what its Agent will be merged against.
 *
 * There is no fabricated caret. Between two file states the runtime reports no
 * position, so drawing one would be an animation rather than a fact. The
 * changed region IS the position, and it is honest.
 */

import { useEffect, useMemo, useRef, useState } from "react";
// The workbench's own Monaco host, not `@monaco-editor/react`. Its loader
// fetches Monaco from a CDN, which is dead on an offline demo machine;
// monacoSetup bundles the editor and themes it to match the workbench.
import { defineThemes, languageOf, monaco } from "./editor/monacoSetup";
import type { ActivityEvent, SessionAgent, WorkspaceFrame } from "./types";
import { clockOf, colorOf, shortId } from "./participants";

/** Where a heading's section lives. Mirrors concord/sections.ts exactly. */
function locate(content: string, heading: string): { start: number; end: number } | null {
  const lines = content.split("\n");
  const index = lines.findIndex((line) => line.trim() === heading.trim());
  if (index === -1) return null;
  const level = /^(#{1,6})\s/.exec(lines[index] as string)?.[1]?.length ?? 0;
  let end = lines.length;
  for (let i = index + 1; i < lines.length; i += 1) {
    const candidate = /^(#{1,6})\s/.exec(lines[i] as string)?.[1]?.length ?? 0;
    if (candidate > 0 && (level === 0 || candidate <= level)) {
      end = i;
      break;
    }
  }
  return { start: index + 1, end };
}

function AgentScreen({
  agent,
  frame,
  latest,
  theme,
  peers,
}: {
  agent: SessionAgent;
  frame: WorkspaceFrame | null;
  /** The newest activity row for this Agent, so the pane has a status line. */
  latest: ActivityEvent | null;
  theme: "light" | "dark";
  /** What the other Agents have landed in canonical state. */
  peers: { agentId: string; title: string; section: string | null; rev: number }[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  /** Cleared on a timer so the flash fades instead of looping forever. */
  const [flash, setFlash] = useState<{ startLine: number; endLine: number } | null>(null);

  /**
   * One read-only Monaco per pane, created once. These panes are watched, not
   * used: the human edits the canonical document in the editor tab, while this
   * shows what an Agent's own copy looks like right now.
   */
  useEffect(() => {
    if (!host.current || editorRef.current) return;
    defineThemes();
    editorRef.current = monaco.editor.create(host.current, {
      value: "",
      language: "markdown",
      theme: theme === "dark" ? "workbench-dark" : "workbench-light",
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      fontSize: 11,
      fontFamily: '"Droid Sans Mono", "Cascadia Code", Menlo, Consolas, monospace',
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      folding: false,
      glyphMargin: false,
      scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
      wordWrap: "on",
      contextmenu: false,
    });
    decorations.current = editorRef.current.createDecorationsCollection([]);
    return () => {
      editorRef.current?.getModel()?.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
    };
    // Created once; every prop below is applied by its own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The frame is the file as it stands on disk. Setting the value rather than
  // rebuilding the model keeps the reader's scroll position between frames.
  useEffect(() => {
    const instance = editorRef.current;
    if (!instance || !frame) return;
    const model = instance.getModel();
    const language = languageOf(frame.docId);
    if (!model) {
      instance.setModel(monaco.editor.createModel(frame.content, language));
      return;
    }
    if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);
    if (model.getValue() !== frame.content) model.setValue(frame.content);
  }, [frame]);

  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? "workbench-dark" : "workbench-light");
  }, [theme]);

  useEffect(() => {
    if (!frame?.changed) return;
    setFlash(frame.changed);
    const timer = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(timer);
  }, [frame?.at, frame?.changed]);

  const band = useMemo(
    () => (frame && agent.section ? locate(frame.content, agent.section) : null),
    [frame, agent.section],
  );

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !frame) return;

    const list: monaco.editor.IModelDeltaDecoration[] = [];
    const lineCount = model.getLineCount();

    // Everything outside this Agent's allocation is dimmed: it is in the file,
    // but it is not this Agent's to touch, and CONCORD will refuse it if it
    // tries. Dimming says that without a word of explanation.
    if (band) {
      if (band.start > 1) {
        list.push({
          range: new monaco.Range(1, 1, Math.min(band.start - 1, lineCount), 1),
          options: { isWholeLine: true, className: "screen-foreign" },
        });
      }
      if (band.end < lineCount) {
        list.push({
          range: new monaco.Range(band.end + 1, 1, lineCount, 1),
          options: { isWholeLine: true, className: "screen-foreign" },
        });
      }
      list.push({
        range: new monaco.Range(band.start, 1, Math.min(band.end, lineCount), 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: "screen-owned-rail",
        },
      });
    }

    if (flash) {
      const start = Math.min(flash.startLine, lineCount);
      const end = Math.min(Math.max(flash.endLine, start), lineCount);
      list.push({
        range: new monaco.Range(start, 1, end, 1),
        options: { isWholeLine: true, className: "screen-flash" },
      });
    }

    if (!decorations.current) {
      decorations.current = editor.createDecorationsCollection(list);
    } else {
      decorations.current.set(list);
    }

    // Follow the edit, the way you would watch over someone's shoulder.
    if (flash) editor.revealLineInCenterIfOutsideViewport(flash.startLine);
  }, [frame, band, flash]);

  const working = agent.state === "in_progress";

  return (
    <div className={"screen" + (working ? " is-working" : "")}>
      <header className="screen-head" style={{ borderTopColor: colorOf(agent.agentId) }}>
        <span className="screen-dot" style={{ background: colorOf(agent.agentId) }} />
        <div className="screen-id">
          <b>{agent.title}</b>
          <span className="mono">
            {shortId(agent.agentId)} · {agent.model}
          </span>
        </div>
        <span className={"state state-" + agent.state}>
          {working ? "working" : agent.state}
        </span>
      </header>

      {agent.section && (
        <div className="screen-section" title="CONCORD refuses any write outside this">
          allocated <b>{agent.section.replace(/^#+\s*/, "")}</b>
          {band ? " · lines " + band.start + "–" + band.end : " · not in the file yet"}
        </div>
      )}

      <div className="screen-body">
        {/*
          The host is ALWAYS mounted, even with nothing to show. Monaco is
          created once against this node on mount; rendering it only when a
          frame exists meant the ref was null exactly when the editor was being
          created, so the pane stayed permanently blank. The empty state sits
          over the top instead.
        */}
        <div className="screen-monaco" ref={host} data-empty={!frame} />
        {!frame && (
          <p className="screen-empty">
            Nothing yet. This pane fills from this Agent's own workspace copy the
            moment it starts writing — it is the file, not a preview of one.
          </p>
        )}
      </div>

      <footer className="screen-foot">
        <span className="screen-latest">
          {latest ? (
            <>
              <i className={working ? "dot-live" : "dot-idle"} />
              {latest.detail}
            </>
          ) : (
            <>
              <i className="dot-idle" />
              idle
            </>
          )}
        </span>
        {frame && <time>{clockOf(frame.at)}</time>}
      </footer>

      {/*
        The awareness strip. Each Agent is told, at the start of every turn,
        the committed state of the shared document - so it genuinely knows what
        the others landed. This shows what that knowledge consists of, rather
        than asserting that it exists.
      */}
      {peers.length > 0 && (
        <div className="screen-peers">
          <span className="screen-peers-label">knows about</span>
          {peers.map((peer) => (
            <span
              key={peer.agentId}
              className="peer-chip"
              style={{ borderColor: colorOf(peer.agentId) }}
              title={
                peer.title +
                " owns " +
                (peer.section ?? "no section") +
                " — committed at rev " +
                peer.rev
              }
            >
              <i style={{ background: colorOf(peer.agentId) }} />
              {(peer.section ?? peer.title).replace(/^#+\s*/, "")}
              <em>rev {peer.rev}</em>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function LiveScreens({
  agents,
  frames,
  activity,
  theme,
  canonicalRev,
}: {
  agents: SessionAgent[];
  frames: WorkspaceFrame[];
  activity: ActivityEvent[];
  theme: "light" | "dark";
  canonicalRev: number;
}) {
  if (agents.length === 0) {
    return (
      <div className="screens-empty">
        <h2>No Agents yet</h2>
        <p>
          Plan a task. The orchestrator allocates one Agent per piece of work and
          gives each its own section of the file — then this becomes one live
          pane per Agent, showing its real workspace as it writes.
        </p>
      </div>
    );
  }

  const byAgent = new Map(frames.map((frame) => [frame.agentId, frame]));
  const newest = new Map<string, ActivityEvent>();
  for (const event of activity) {
    if (!newest.has(event.agentId)) newest.set(event.agentId, event);
  }

  return (
    <div className="screens" data-count={Math.min(agents.length, 3)}>
      {agents.map((agent) => (
        <AgentScreen
          key={agent.agentId}
          agent={agent}
          frame={byAgent.get(agent.agentId) ?? null}
          latest={newest.get(agent.agentId) ?? null}
          theme={theme}
          peers={agents
            .filter((other) => other.agentId !== agent.agentId)
            .map((other) => ({
              agentId: other.agentId,
              title: other.title,
              section: other.section,
              rev: canonicalRev,
            }))}
        />
      ))}
    </div>
  );
}
