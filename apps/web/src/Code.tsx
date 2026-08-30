/**
 * The code surface: line numbers, syntax colour, per-line Agent attribution,
 * and a selection you can act on.
 *
 * Two deliberate omissions, both from the reel:
 *
 *   No Monaco. A read-only viewer with attribution is a few hundred lines and
 *   has no bundle cost; an editor would be a large dependency for a surface
 *   that must not be edited by hand anyway - every change here goes through an
 *   Agent and then through CONCORD.
 *
 *   No character-level cursors. Codex reports items, not keystrokes, so a
 *   moving cursor would be an animation rather than a fact. What the backend
 *   genuinely knows is which Agent is on the document and whether it is
 *   viewing or editing, and that is what the gutter shows.
 */

import type { JSX } from "react";
import type { BlameLine, PresenceEntry } from "./types";
import { colorOf, shortId, washOf } from "./participants";

/**
 * A deliberately small tokenizer. It covers the languages this demo actually
 * shows - Markdown, TypeScript, JSON - and colours nothing it is unsure about,
 * which is the right failure mode for a viewer: uncoloured code still reads.
 */
const TS_KEYWORDS =
  /\b(await|async|break|case|catch|class|const|continue|default|delete|do|else|export|extends|finally|for|from|function|if|implements|import|in|instanceof|interface|let|new|of|return|static|switch|this|throw|try|type|typeof|var|void|while|yield|readonly|private|public|protected|enum|as|satisfies)\b/;

interface Token {
  text: string;
  cls: string;
}

function tokenizeCode(line: string): Token[] {
  const tokens: Token[] = [];
  // Order matters: comments and strings win over everything inside them.
  const pattern =
    /(\/\/.*$|\/\*[\s\S]*?\*\/|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\w\s])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const [text, comment, str, num, word, space] = match;
    if (comment) tokens.push({ text, cls: "t-comment" });
    else if (str) tokens.push({ text, cls: "t-string" });
    else if (num) tokens.push({ text, cls: "t-number" });
    else if (word) {
      tokens.push({ text, cls: TS_KEYWORDS.test(word) ? "t-keyword" : "t-plain" });
    } else if (space) tokens.push({ text, cls: "t-plain" });
    else tokens.push({ text, cls: "t-punct" });
  }
  return tokens;
}

function tokenizeMarkdown(line: string): Token[] {
  if (/^\s*#{1,6}\s/.test(line)) return [{ text: line, cls: "t-heading" }];
  if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
    const marker = line.match(/^\s*([-*+]|\d+\.)\s/)?.[0] ?? "";
    return [
      { text: marker, cls: "t-punct" },
      { text: line.slice(marker.length), cls: "t-plain" },
    ];
  }
  if (/^\s*>/.test(line)) return [{ text: line, cls: "t-comment" }];
  if (/^\s*```/.test(line)) return [{ text: line, cls: "t-punct" }];
  return [{ text: line, cls: "t-plain" }];
}

export function highlight(line: string, docId: string): Token[] {
  if (line.length === 0) return [{ text: " ", cls: "t-plain" }];
  return /\.(md|markdown|txt)$/i.test(docId)
    ? tokenizeMarkdown(line)
    : tokenizeCode(line);
}

export interface Selection {
  start: number;
  end: number;
}

export function CodeView({
  docId,
  content,
  blame,
  present,
  selection,
  showBlame,
  onSelect,
}: {
  docId: string;
  content: string;
  blame: BlameLine[] | null;
  present: PresenceEntry[];
  selection: Selection | null;
  showBlame: boolean;
  onSelect: (line: number, extend: boolean) => void;
}): JSX.Element {
  const lines = content.split("\n");

  // Presence is document-level, because that is the resolution CONCORD records
  // it at. Rendering it beside the first line would imply the Agent is on THAT
  // line, which the backend never claimed.
  const editing = present.filter((who) => who.activity === "editing");

  return (
    <div className="code">
      {editing.length > 0 && (
        <div className="code-presence">
          {editing.map((who) => (
            <span
              key={who.agentId}
              className="presence-chip"
              style={{ borderColor: colorOf(who.humanId ?? who.agentId) }}
            >
              <i style={{ background: colorOf(who.humanId ?? who.agentId) }} />
              {shortId(who.agentId)} is editing this document
            </span>
          ))}
        </div>
      )}

      <div className="code-lines">
        {lines.map((text, index) => {
          const number = index + 1;
          const attribution = blame?.[index] ?? null;
          const author = attribution?.lastModifiedByAgentId ?? null;
          const inRange =
            selection !== null && number >= selection.start && number <= selection.end;
          return (
            <div
              key={index}
              className={"code-line" + (inRange ? " is-selected" : "")}
              style={
                inRange && author ? { background: washOf(author, 0.12) } : undefined
              }
              onMouseDown={(event) => onSelect(number, event.shiftKey)}
            >
              <span className="code-gutter">{number}</span>
              {showBlame && (
                <span
                  className="code-blame"
                  style={author ? { color: colorOf(author) } : undefined}
                  title={
                    author
                      ? "Last changed by " +
                        author +
                        " at v" +
                        attribution?.atVersion +
                        (attribution?.message ? " — " + attribution.message : "")
                      : "Not changed by any Agent — seeded or human-authored"
                  }
                >
                  <i
                    className="code-blame-bar"
                    style={{ background: author ? colorOf(author) : "transparent" }}
                  />
                  {author ? shortId(author) : "—"}
                </span>
              )}
              <code className="code-text">
                {highlight(text, docId).map((token, position) => (
                  <span key={position} className={token.cls}>
                    {token.text}
                  </span>
                ))}
              </code>
            </div>
          );
        })}
      </div>
    </div>
  );
}
