/**
 * Command palette and quick open - one component, because they are one widget
 * in VS Code too. The mode is read off the first character of the input: ">"
 * runs commands, anything else opens a document. That is why Ctrl+P and
 * Ctrl+Shift+P can hand off to each other without closing.
 *
 * Built on a native <dialog>. `showModal()` gives Escape-to-close, a focus
 * trap and an inert backdrop for free - all three of which are otherwise a
 * dependency.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Command } from "./commands";
import { fuzzy } from "./commands";
import { Codicon } from "./Codicon";

export interface PaletteDoc {
  id: string;
  version: number;
}

export function CommandPalette({
  open,
  initialMode,
  commands,
  docs,
  onOpenDoc,
  onClose,
}: {
  open: boolean;
  initialMode: ">" | "";
  commands: Command[];
  docs: PaletteDoc[];
  onOpenDoc: (docId: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState<string>(initialMode);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery(initialMode);
      setActive(0);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, initialMode]);

  const isCommandMode = query.startsWith(">");
  const term = isCommandMode ? query.slice(1).trim() : query.trim();

  const results = useMemo(() => {
    if (isCommandMode) {
      return commands
        .filter((entry) => !entry.hidden)
        .filter((entry) => fuzzy(term, entry.category + ": " + entry.title));
    }
    return docs.filter((entry) => fuzzy(term, entry.id));
  }, [isCommandMode, term, commands, docs]);

  const choose = (index: number): void => {
    const hit = results[index];
    if (!hit) return;
    onClose();
    if (isCommandMode) void (hit as Command).run();
    else onOpenDoc((hit as PaletteDoc).id);
  };

  return (
    <dialog
      className="palette"
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        // Clicking the backdrop lands on the dialog itself, never a child.
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="palette-input">
        <Codicon name={isCommandMode ? "chevron-right" : "search"} />
        <input
          autoFocus
          value={query}
          placeholder="Type '>' for commands, or a file name to open"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((at) => Math.min(results.length - 1, at + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((at) => Math.max(0, at - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(active);
            }
          }}
        />
      </div>

      <ul className="palette-list">
        {results.length === 0 && <li className="palette-empty">No matching results</li>}
        {results.slice(0, 60).map((entry, index) => {
          const command = isCommandMode ? (entry as Command) : null;
          const doc = isCommandMode ? null : (entry as PaletteDoc);
          return (
            <li
              key={command?.id ?? doc?.id}
              className="palette-row"
              data-active={index === active}
              data-disabled={command?.enabled === false}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              {command ? (
                <>
                  <span className="palette-cat">{command.category}:</span>
                  <span className="palette-title">{command.title}</span>
                  {command.key && <kbd className="palette-key">{command.key}</kbd>}
                </>
              ) : (
                <>
                  <Codicon name="file" />
                  <span className="palette-title">{doc?.id.split("/").at(-1)}</span>
                  <span className="palette-cat">{doc?.id}</span>
                  <kbd className="palette-key">rev {doc?.version}</kbd>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </dialog>
  );
}
