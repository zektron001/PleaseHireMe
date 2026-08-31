/**
 * The status bar as an item list rather than a fixed row of spans, so a new
 * indicator is one object rather than a JSX edit in the middle of the shell.
 */

import type { ReactNode } from "react";
import { Codicon } from "./Codicon";

export interface StatusItem {
  id: string;
  icon?: string;
  text: ReactNode;
  title?: string;
  /** "remote" paints the green shoulder VS Code gives the remote indicator. */
  tone?: "remote" | "warn" | "error";
  onClick?: () => void;
}

export function StatusBar({ left, right }: { left: StatusItem[]; right: StatusItem[] }) {
  const render = (item: StatusItem) => {
    const content = (
      <>
        {item.icon && <Codicon name={item.icon} />}
        <span>{item.text}</span>
      </>
    );
    return item.onClick ? (
      <button
        key={item.id}
        className="status-item"
        data-tone={item.tone}
        title={item.title}
        onClick={item.onClick}
      >
        {content}
      </button>
    ) : (
      <span key={item.id} className="status-item" data-tone={item.tone} title={item.title}>
        {content}
      </span>
    );
  };

  return (
    <footer className="statusbar" data-tour="statusbar">
      <div className="status-side">{left.map(render)}</div>
      <div className="status-side status-right">{right.map(render)}</div>
    </footer>
  );
}
