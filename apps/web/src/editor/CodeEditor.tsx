/**
 * The Monaco host.
 *
 * This component owns NO network call. Everything it can do to a document goes
 * out through a prop, because the human write path is being built alongside
 * this and there must not end up being two of them. `onRequestSave` is the
 * seam: give it the content and the version the buffer was based on, and it
 * returns what CONCORD said.
 *
 * What the implementer of `onRequestSave` should call:
 *
 *   POST /api/concord/docs/:docId  { agentId, expectedVersion, content }
 *
 * and map the status code straight through - the route already distinguishes
 * 200 written/merged, 403 denied, 409 conflict and 423 leased, so the editor
 * can tell "locked" from "someone beat you" from "not allowed" without parsing
 * a message.
 *
 * A merged result comes back with content that is NOT what was typed, because
 * another Agent's independent edit was folded in. That is applied through
 * `pushEditOperations` rather than `setValue` so undo history and the cursor
 * survive it.
 */

import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import { monaco, defineThemes, languageOf } from "./monacoSetup";
import {
  blameDecorations,
  caretDecorations,
  commentDecorations,
  conflictDecorations,
  ensureHueStyles,
} from "./decorations";
import type {
  BlameLine,
  PendingConflict,
  PresenceEntry,
  ReviewComment,
} from "../types";
import type { Selection } from "../Code";
import { humanName, shortId } from "../participants";
import "./editor.css";

export type SaveOutcome =
  | { status: "written" | "merged"; version: number; content: string }
  | { status: "denied"; reason: string }
  | { status: "leased"; holder: string }
  | { status: "conflict"; conflictId: string };

export interface CodeEditorProps {
  docId: string;
  value: string;
  /** The revision `value` was read at. It is the CAS token for a write. */
  version: number;
  theme: "light" | "dark";
  readOnly: boolean;
  blame: BlameLine[] | null;
  showBlame: boolean;
  present: PresenceEntry[];
  viewerAgentId: string | null;
  comments: ReviewComment[];
  conflicts: PendingConflict[];
  onSelect?: (selection: Selection | null) => void;
  /** Owned by the human-in-the-loop write path. Absent means read-only. */
  onRequestSave?: (content: string, expectedVersion: number) => Promise<SaveOutcome>;
}

export function CodeEditor({
  docId,
  value,
  version,
  theme,
  readOnly,
  blame,
  showBlame,
  present,
  viewerAgentId,
  comments,
  conflicts,
  onSelect,
  onRequestSave,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const collection = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  /** One model per document, so switching tabs keeps undo history and folds. */
  const models = useRef(new Map<string, Monaco.editor.ITextModel>());
  const viewStates = useRef(new Map<string, Monaco.editor.ICodeEditorViewState | null>());
  const [status, setStatus] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!host.current || editor.current) return;
    defineThemes();
    editor.current = monaco.editor.create(host.current, {
      value: "",
      theme: theme === "dark" ? "workbench-dark" : "workbench-light",
      automaticLayout: true,
      fontFamily: '"Droid Sans Mono", "Cascadia Code", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: true, renderCharacters: false },
      glyphMargin: true,
      lineNumbersMinChars: 4,
      renderLineHighlight: "line",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      readOnly: true,
      contextmenu: true,
    });
    collection.current = editor.current.createDecorationsCollection([]);

    return () => {
      editor.current?.dispose();
      editor.current = null;
      for (const model of models.current.values()) model.dispose();
      models.current.clear();
    };
    // Created once. Every prop below is applied by its own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the model when the tab changes, restoring where the reader was.
  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    const previous = instance.getModel();
    if (previous) {
      const previousId = [...models.current.entries()].find(
        ([, model]) => model === previous,
      )?.[0];
      if (previousId) viewStates.current.set(previousId, instance.saveViewState());
    }

    let model = models.current.get(docId);
    if (!model) {
      model = monaco.editor.createModel(value, languageOf(docId));
      models.current.set(docId, model);
    }
    instance.setModel(model);
    instance.restoreViewState(viewStates.current.get(docId) ?? null);
    setDirty(false);
  }, [docId, value]);

  /**
   * Server content wins over an untouched buffer. It does NOT clobber a buffer
   * the human has edited - losing someone's typing to a two-second poll would
   * be the worst possible bug in a collaborative editor.
   */
  useEffect(() => {
    const model = models.current.get(docId);
    if (!model || dirty) return;
    if (model.getValue() !== value) {
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: value }],
        () => null,
      );
    }
  }, [value, docId, dirty]);

  useEffect(() => {
    editor.current?.updateOptions({
      readOnly: readOnly || !onRequestSave,
      lineDecorationsWidth: showBlame ? 18 : 6,
    });
  }, [readOnly, onRequestSave, showBlame]);

  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? "workbench-dark" : "workbench-light");
  }, [theme]);

  // Decorations: blame, comments, conflicts, remote carets.
  useEffect(() => {
    const model = models.current.get(docId);
    if (!collection.current || !model) return;
    ensureHueStyles([
      ...present.map((who) => ({
        id: who.humanId ?? who.agentId,
        label: humanName(who.humanId) || shortId(who.agentId),
      })),
      ...(blame ?? [])
        .map((line) => line.lastModifiedByAgentId)
        .filter((id): id is string => id !== null)
        .map((id) => ({ id, label: shortId(id) })),
    ]);
    collection.current.set([
      ...(showBlame && blame ? blameDecorations(blame) : []),
      ...commentDecorations(comments),
      ...conflictDecorations(conflicts),
      ...caretDecorations(present, viewerAgentId, model),
    ]);
  }, [docId, blame, showBlame, comments, conflicts, present, viewerAgentId]);

  // Selection out, for the review and consultation flows.
  useEffect(() => {
    const instance = editor.current;
    if (!instance || !onSelect) return;
    const handle = instance.onDidChangeCursorSelection((event) => {
      const range = event.selection;
      if (range.isEmpty()) onSelect(null);
      else onSelect({ start: range.startLineNumber, end: range.endLineNumber });
    });
    return () => handle.dispose();
  }, [onSelect]);

  useEffect(() => {
    const model = models.current.get(docId);
    if (!model) return;
    const handle = model.onDidChangeContent(() => setDirty(true));
    return () => handle.dispose();
  }, [docId]);

  const save = async (): Promise<void> => {
    const model = models.current.get(docId);
    if (!model || !onRequestSave) return;
    setStatus("Saving…");
    const outcome = await onRequestSave(model.getValue(), version);
    if (outcome.status === "written") {
      setStatus("Saved as rev " + outcome.version);
      setDirty(false);
    } else if (outcome.status === "merged") {
      // Someone else's independent edit came back folded in.
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: outcome.content }],
        () => null,
      );
      setStatus("Merged with another Agent's edit · rev " + outcome.version);
      setDirty(false);
    } else if (outcome.status === "denied") {
      setStatus("Denied: " + outcome.reason);
    } else if (outcome.status === "leased") {
      setStatus("Locked by " + outcome.holder);
    } else {
      setStatus("Conflict — the canonical content was kept. Settle it in Problems.");
    }
  };

  // Ctrl+S saves, and is swallowed so the browser does not offer to save the page.
  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    const handle = instance.addAction({
      id: "concord.save",
      label: "Save through CONCORD",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => void save(),
    });
    return () => handle.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, version, onRequestSave]);

  return (
    <div className="code-editor">
      <div className="code-editor-host" ref={host} />
      {(dirty || status) && (
        <div className="code-editor-status">
          {dirty && <span className="dirty-dot" />}
          <span>{status ?? "Unsaved changes"}</span>
          {dirty && onRequestSave && (
            <button onClick={() => void save()}>Save (Ctrl+S)</button>
          )}
        </div>
      )}
    </div>
  );
}
