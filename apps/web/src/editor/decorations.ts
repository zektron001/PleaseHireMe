/**
 * Everything the editor draws that is not the text itself.
 *
 * These are pure functions from server data to Monaco decorations, so what the
 * editor shows can be reasoned about - and tested - without a DOM.
 *
 * ---------------------------------------------------------------------------
 * On the carets, because this reverses a documented refusal.
 *
 * A caret here means exactly one thing: **the character position at which that
 * Agent's last committed edit ended, at the revision named in its label.** It
 * is not a keystroke position, and it is not sampled. CONCORD computes it in
 * `reconcileProvenance`, inside the same critical section that already diffs
 * the previous content against the next one to attribute lines - so the caret
 * is arithmetic over two strings the store already holds, not a new
 * measurement, and it is carried out on `PresenceEntry.caret` under the same
 * 15-second TTL as the rest of presence.
 *
 * The caret does NOT move during a turn. Codex reports completed items, not
 * keystrokes (`parseActivity` in live/activity.ts: a `file_change` item carries
 * paths and nothing else), so between two commits there is no position to
 * report and none is invented. Mid-turn the honest signal is *which file*,
 * which is the pulsing dot on the tab.
 *
 * The fabrication line: animating a caret BETWEEN two committed positions
 * would be an interpolation rather than a measurement, so it is not done. The
 * caret jumps. `docs/AMOEBA_INSPIRATION_SCOPE.md` §5 records this in full.
 */

import type { monaco } from "./monacoSetup";
import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import type { BlameLine, PendingConflict, PresenceEntry, ReviewComment } from "../types";
import { colorOf, shortId } from "../participants";

type Deco = Monaco.editor.IModelDeltaDecoration;

/** A stable, CSS-safe class suffix for one participant's colour. */
export function hueClass(id: string): string {
  return "hue-" + id.replace(/[^a-zA-Z0-9]/g, "").slice(-12);
}

/**
 * Injects one rule per participant, once. Monaco decorations are addressed by
 * class name, so per-agent colours cannot be inline styles.
 */
export function ensureHueStyles(participants: { id: string; label?: string }[]): void {
  const id = "workbench-hues";
  let tag = document.getElementById(id) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.id = id;
    document.head.append(tag);
  }
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const who of participants) {
    const cls = hueClass(who.id);
    if (seen.has(cls)) continue;
    seen.add(cls);
    const colour = colorOf(who.id);
    // The label rides on the caret as a pseudo-element. A Monaco content widget
    // would be the heavier way to the same picture, and it would have to be
    // repositioned by hand on every scroll.
    const label = (who.label ?? who.id).replace(/["\\]/g, "");
    rules.push(
      "." + cls + "-blame { border-left: 3px solid " + colour + "; }\n" +
      "." + cls + "-caret { border-left: 2px solid " + colour + "; margin-left: -1px; }\n" +
      "." + cls + "-caret::after { content: \"" + label + "\"; background: " + colour + "; }\n" +
      "." + cls + "-wash { background: color-mix(in srgb, " + colour + " 12%, transparent); }",
    );
  }
  tag.textContent = rules.join("\n");
}

/** Per-line attribution in the margin, coloured by the Agent that last wrote it. */
export function blameDecorations(lines: BlameLine[]): Deco[] {
  return lines
    .filter((line) => line.lastModifiedByAgentId !== null)
    .map((line) => ({
      range: { startLineNumber: line.lineNumber, startColumn: 1, endLineNumber: line.lineNumber, endColumn: 1 },
      options: {
        isWholeLine: true,
        linesDecorationsClassName:
          hueClass(line.lastModifiedByAgentId as string) + "-blame blame-margin",
        hoverMessage: {
          value:
            "**" + shortId(line.lastModifiedByAgentId as string) + "** · rev " +
            line.atVersion +
            (line.message ? "\n\n" + line.message : ""),
        },
      },
    }));
}

/** A comment glyph on the first line of each open comment's range. */
export function commentDecorations(comments: ReviewComment[]): Deco[] {
  return comments
    .filter((comment) => comment.status !== "resolved")
    .map((comment) => ({
      range: {
        startLineNumber: comment.startLine,
        startColumn: 1,
        endLineNumber: comment.endLine,
        endColumn: 1,
      },
      options: {
        isWholeLine: true,
        glyphMarginClassName: "codicon codicon-comment comment-glyph",
        className: "comment-range",
        glyphMarginHoverMessage: { value: comment.body },
      },
    }));
}

/** The contested line ranges of every open conflict on this document. */
export function conflictDecorations(conflicts: PendingConflict[]): Deco[] {
  const out: Deco[] = [];
  for (const conflict of conflicts) {
    for (const range of conflict.conflicts) {
      // `at` is the 0-based line index the hunk starts on, in base coordinates,
      // and `base` is the lines it covers. A pure insertion covers none, so the
      // range collapses onto its single anchor line.
      const start = range.at + 1;
      const end = start + Math.max(0, range.base.length - 1);
      out.push({
        range: {
          startLineNumber: start,
          startColumn: 1,
          endLineNumber: end,
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: "conflict-range",
          linesDecorationsClassName: "codicon codicon-warning conflict-glyph",
          hoverMessage: {
            value:
              "Contested by **" + shortId(conflict.agentId) + "** against rev " +
              conflict.atVersion +
              ". The canonical content was kept; a human settles this.",
          },
        },
      });
    }
  }
  return out;
}

/**
 * One caret per other participant present on this document, placed at the
 * character their last commit ended on. See the header for what this is and,
 * more importantly, what it is not.
 */
export function caretDecorations(
  present: PresenceEntry[],
  viewerAgentId: string | null,
  model: Monaco.editor.ITextModel | null,
): Deco[] {
  const out: Deco[] = [];
  for (const who of present) {
    if (who.agentId === viewerAgentId) continue;
    const caret = who.caret;
    if (!caret) continue;

    // A caret from an older revision can point past the end of the current
    // content. Clamping is honest - the position is stale, not wrong - and it
    // stops Monaco throwing on an out-of-range decoration.
    const lineCount = model?.getLineCount() ?? caret.line;
    const line = Math.min(Math.max(1, caret.line), lineCount);
    const maxColumn = model?.getLineMaxColumn(line) ?? caret.column;
    const column = Math.min(Math.max(1, caret.column), maxColumn);

    const who_id = who.humanId ?? who.agentId;
    out.push({
      range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column },
      options: {
        // `className` on a zero-width range renders nothing at all -
        // beforeContentClassName is what Monaco provides for a marker AT a
        // position, which is exactly what a caret is.
        beforeContentClassName: hueClass(who_id) + "-caret remote-caret",
        stickiness: 1, // NeverGrowsWhenTypingAtEdges
        hoverMessage: {
          value:
            "**" + shortId(who.agentId) + "** last committed here at rev " +
            (caret.atVersion ?? "?") +
            "\n\nThis marks where a commit ended, not where a cursor is now.",
        },
      },
    });
    out.push({
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
      options: { isWholeLine: true, className: hueClass(who_id) + "-wash" },
    });
  }
  return out;
}

export type { Deco };
export { monaco };
