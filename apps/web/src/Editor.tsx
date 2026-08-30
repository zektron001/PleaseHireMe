/**
 * The canonical file, editable.
 *
 * This is the half of the pitch that git and a plain viewer cannot do: the
 * human types directly into the shared document while Agents are working on it,
 * and the save goes through CONCORD as an attributed revision rather than
 * around it.
 *
 * Monaco, and only here. The read-only per-Agent screens use it too, but the
 * reason it earns its size is this surface: real editing, real syntax, and
 * decorations that carry information the platform actually holds -
 *
 *   section bands   which Agent CONCORD confines to which lines
 *   blame gutter    which Agent last changed each line
 *   change flash    where an Agent's edit just landed
 *
 * The one thing NOT decorated is a moving caret for an Agent. The runtime
 * reports completed items, not keystrokes, so between two file states there is
 * no position to draw. The changed region is a fact; a caret would not be.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { defineThemes, languageOf, monaco as monacoNs } from "./monaco";
import type { BlameLine, SectionAllocation } from "./types";
import { colorOf, shortId } from "./participants";

type MonacoEditor = monacoNs.editor.IStandaloneCodeEditor;

/** Where a heading's section starts and ends, mirroring concord/sections.ts. */
function locate(content: string, heading: string): { start: number; end: number } | null {
  const lines = content.split("\n");
  const wanted = heading.trim();
  const index = lines.findIndex((line) => line.trim() === wanted);
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

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "conflict" | "error";

export function DocumentEditor({
  docId,
  content,
  version,
  blame,
  allocations,
  theme,
  readOnly,
  onSave,
  onSelect,
}: {
  docId: string;
  content: string;
  version: number;
  blame: BlameLine[] | null;
  allocations: SectionAllocation[];
  theme: "light" | "dark";
  /** True while an Agent holds the file, when editing would race a turn. */
  readOnly: boolean;
  onSave: (next: string) => Promise<"written" | "stale" | "error">;
  onSelect: (range: { start: number; end: number } | null) => void;
}) {
  const editorRef = useRef<MonacoEditor | null>(null);
  const decorationsRef = useRef<monacoNs.editor.IEditorDecorationsCollection | null>(null);
  const [draft, setDraft] = useState(content);
  const [state, setState] = useState<SaveState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The version the current draft was based on, so a save is never blind. */
  const baseVersion = useRef(version);

  // Adopt canonical content whenever the document moves underneath us AND the
  // human has nothing unsaved. Clobbering an in-progress edit because an Agent
  // committed would be the single most annoying thing this editor could do.
  useEffect(() => {
    if (state === "dirty" || state === "saving") return;
    setDraft(content);
    baseVersion.current = version;
  }, [content, version, state]);

  const save = useCallback(
    async (next: string) => {
      setState("saving");
      const outcome = await onSave(next);
      if (outcome === "written") {
        baseVersion.current += 1;
        setState("saved");
        // Back to idle so the effect above resumes following canonical content.
        setTimeout(() => setState((s) => (s === "saved" ? "idle" : s)), 1200);
      } else if (outcome === "stale") {
        setState("conflict");
      } else {
        setState("error");
      }
    },
    [onSave],
  );

  /** Autosave, debounced. Short enough to feel live, long enough not to thrash. */
  const scheduleSave = useCallback(
    (next: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(next), 900);
    },
    [save],
  );

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const bands = useMemo(
    () =>
      allocations
        .map((allocation) => ({
          allocation,
          range: locate(draft, allocation.heading),
        }))
        .filter((entry) => entry.range !== null),
    [allocations, draft],
  );

  /** Repaints section bands and blame. Cheap enough to run on every change. */
  const paint = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;

    const decorations: monacoNs.editor.IModelDeltaDecoration[] = [];

    for (const { allocation, range } of bands) {
      if (!range) continue;
      decorations.push({
        range: new monacoNs.Range(range.start, 1, Math.max(range.start, range.end), 1),
        options: {
          isWholeLine: true,
          className: "band-" + hueClass(allocation.agentId),
          linesDecorationsClassName: "band-rail-" + hueClass(allocation.agentId),
          hoverMessage: {
            value:
              "**" +
              allocation.heading +
              "** — allocated to `" +
              shortId(allocation.agentId) +
              "`. CONCORD refuses any Agent write outside these lines.",
          },
        },
      });
    }

    for (const line of blame ?? []) {
      const who = line.lastModifiedByAgentId;
      if (!who && !line.lastModifiedByHumanId) continue;
      if (line.lineNumber > model.getLineCount()) break;
      decorations.push({
        range: new monacoNs.Range(line.lineNumber, 1, line.lineNumber, 1),
        options: {
          glyphMarginClassName: who
            ? "blame-glyph blame-" + hueClass(who)
            : "blame-glyph blame-human",
          glyphMarginHoverMessage: {
            value: who
              ? "Last changed by `" +
                shortId(who) +
                "` at rev " +
                line.atVersion +
                (line.message ? "\n\n" + line.message : "")
              : "Typed by you",
          },
        },
      });
    }

    if (!decorationsRef.current) {
      decorationsRef.current = editor.createDecorationsCollection(decorations);
    } else {
      decorationsRef.current.set(decorations);
    }
  }, [bands, blame]);

  useEffect(() => paint(), [paint, draft]);

  const mount: OnMount = (editor, instance) => {
    editorRef.current = editor;
    defineThemes(instance);
    instance.editor.setTheme(theme === "dark" ? "concord-dark" : "concord-light");
    editor.onDidChangeCursorSelection((event) => {
      const selection = event.selection;
      onSelect({
        start: selection.startLineNumber,
        end: selection.endLineNumber,
      });
    });
    paint();
  };

  useEffect(() => {
    if (!editorRef.current) return;
    monacoNs.editor.setTheme(theme === "dark" ? "concord-dark" : "concord-light");
  }, [theme]);

  return (
    <div className="editor">
      <div className="editor-bar">
        <span className="editor-path">{docId}</span>
        <span className="editor-rev">rev {version}</span>
        <span className={"save-state save-" + state}>
          {readOnly
            ? "read-only — an Agent is working"
            : state === "saving"
              ? "saving…"
              : state === "saved"
                ? "saved"
                : state === "dirty"
                  ? "unsaved"
                  : state === "conflict"
                    ? "the document moved — reopen to get the latest"
                    : state === "error"
                      ? "save failed"
                      : "autosaves as you type"}
        </span>
        <span className="editor-bands">
          {bands.map(({ allocation }) => (
            <span
              key={allocation.agentId}
              className="band-chip"
              style={{ borderColor: colorOf(allocation.agentId) }}
              title={allocation.heading + " → " + allocation.agentId}
            >
              <i style={{ background: colorOf(allocation.agentId) }} />
              {allocation.heading.replace(/^#+\s*/, "")}
            </span>
          ))}
        </span>
      </div>

      <div className="editor-surface">
        <Editor
          height="100%"
          language={languageOf(docId)}
          value={draft}
          onMount={mount}
          onChange={(next) => {
            if (next === undefined || readOnly) return;
            setDraft(next);
            setState("dirty");
            scheduleSave(next);
          }}
          options={{
            readOnly,
            minimap: { enabled: false },
            glyphMargin: true,
            lineNumbersMinChars: 4,
            fontSize: 12.5,
            fontFamily:
              'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
            scrollBeyondLastLine: false,
            renderLineHighlight: "line",
            automaticLayout: true,
            padding: { top: 10, bottom: 24 },
            wordWrap: "on",
            smoothScrolling: true,
          }}
        />
      </div>
    </div>
  );
}

/**
 * Ten stable classes rather than inline colours, because Monaco decorations
 * take a class name and not a style object.
 */
export function hueClass(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return "h" + (Math.abs(h) % 10);
}
