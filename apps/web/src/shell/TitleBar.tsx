/**
 * The title bar: menus on the left, the quick-input box in the middle, layout
 * toggles on the right. Same three zones VS Code uses.
 *
 * The menus are <details> elements, not a menu framework. That buys keyboard
 * toggling, Escape, and click-outside-to-close from the platform, and the whole
 * bar stays under a hundred lines.
 */

import { useEffect, useRef } from "react";
import type { Command } from "./commands";
import type { Human } from "../types";
import { Codicon } from "./Codicon";
import { colorOf, initialsOf } from "../participants";
import type { ThemeChoice } from "../theme";

export interface Menu {
  label: string;
  items: (Command | "separator")[];
}

export function TitleBar({
  menus,
  humans,
  me,
  onSignIn,
  onQuickOpen,
  onShare,
  shareTarget,
  onTour,
  theme,
  onCycleTheme,
  sidebarOpen,
  panelOpen,
  onToggleSidebar,
  onTogglePanel,
}: {
  menus: Menu[];
  humans: Human[];
  me: Human | null;
  onSignIn: (human: Human) => void;
  onQuickOpen: () => void;
  /** Opens the share sheet for the open document. Null when none is open. */
  onShare: () => void;
  shareTarget: string | null;
  /** DEV ONLY: replays the first-run tour. See the note at the call site. */
  onTour: () => void;
  theme: ThemeChoice;
  onCycleTheme: () => void;
  sidebarOpen: boolean;
  panelOpen: boolean;
  onToggleSidebar: () => void;
  onTogglePanel: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);

  // One open menu at a time, and a click anywhere else closes it.
  useEffect(() => {
    const closeAll = (event: MouseEvent) => {
      if (bar.current?.contains(event.target as Node)) return;
      bar.current?.querySelectorAll("details[open]").forEach((entry) => {
        (entry as HTMLDetailsElement).open = false;
      });
    };
    document.addEventListener("click", closeAll);
    return () => document.removeEventListener("click", closeAll);
  }, []);

  return (
    <header className="titlebar" data-tour="titlebar">
      <div className="titlebar-menus" ref={bar}>
        <span className="titlebar-logo">
          <Codicon name="layers" />
        </span>
        {menus.map((menu) => (
          <details
            key={menu.label}
            className="menu"
            onToggle={(event) => {
              if (!(event.currentTarget as HTMLDetailsElement).open) return;
              bar.current?.querySelectorAll("details[open]").forEach((other) => {
                if (other !== event.currentTarget) (other as HTMLDetailsElement).open = false;
              });
            }}
          >
            <summary>{menu.label}</summary>
            <ul className="menu-list">
              {menu.items.map((item, index) =>
                item === "separator" ? (
                  <li key={"sep" + index} className="menu-sep" />
                ) : (
                  <li key={item.id}>
                    <button
                      disabled={item.enabled === false}
                      onClick={(event) => {
                        const details = event.currentTarget.closest("details");
                        if (details) (details as HTMLDetailsElement).open = false;
                        void item.run();
                      }}
                    >
                      <span>{item.title}</span>
                      {item.key && <kbd>{item.key}</kbd>}
                    </button>
                  </li>
                ),
              )}
            </ul>
          </details>
        ))}
      </div>

      <button className="quick-input" data-tour="quick-input" onClick={onQuickOpen}>
        <Codicon name="search" />
        <span>{me ? "Search files and commands" : "Sign in to begin"}</span>
      </button>

      <div className="titlebar-right">
        {/* Google Docs puts Share top-right and so does everyone who copied it.
            Keeping it there means nobody has to be told where it is. */}
        <button
          className="share-button"
          data-tour="share-button"
          disabled={!me || !shareTarget}
          onClick={onShare}
          title={
            shareTarget
              ? "Share " + shareTarget
              : "Open a document to share it"
          }
        >
          <Codicon name="person-add" />
          Share
        </button>

        {/* DEV ONLY. This button goes away when the tour becomes first-run
            only - see useTour.ts, which already reads and writes the seen
            key. Until then it is how anyone (a judge included) replays it. */}
        <button className="icon-button" onClick={onTour} title="Replay the tour (dev)">
          <Codicon name="rocket" />
        </button>

        <div className="whoami" data-tour="whoami">
          {humans.map((human) => (
            <button
              key={human.id}
              className="whoami-chip"
              data-active={me?.id === human.id}
              onClick={() => onSignIn(human)}
              title={"Sign in as " + human.id}
            >
              <span className="avatar sm" style={{ background: colorOf(human.id) }}>
                {initialsOf(human.id, null)}
              </span>
              {human.displayName}
            </button>
          ))}
        </div>
        <button
          className="icon-button"
          onClick={onCycleTheme}
          title={"Theme: " + theme + " - click to cycle light / dark / system"}
        >
          <Codicon
            name={theme === "light" ? "color-mode" : theme === "dark" ? "circle-filled" : "circle-large"}
          />
        </button>
        <button
          className="icon-button"
          data-active={sidebarOpen}
          onClick={onToggleSidebar}
          title="Toggle Primary Side Bar (Ctrl+B)"
        >
          <Codicon name="layout-sidebar-left" />
        </button>
        <button
          className="icon-button"
          data-active={panelOpen}
          onClick={onTogglePanel}
          title="Toggle Panel (Ctrl+J)"
        >
          <Codicon name="layout-panel" />
        </button>
      </div>
    </header>
  );
}
