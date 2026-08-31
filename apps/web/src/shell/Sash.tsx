/**
 * A draggable divider.
 *
 * It writes the size straight onto a CSS custom property on <html> rather than
 * into React state, so a drag does not re-render the workbench on every
 * pointermove - which matters once Monaco is mounted in the editor area.
 * `setPointerCapture` is what keeps the drag alive when the pointer leaves the
 * 4px hit area, and it is why this needs no window-level listeners.
 */

import { useRef } from "react";

export function Sash({
  orientation,
  variable,
  min,
  max,
  invert,
  onCommit,
}: {
  orientation: "vertical" | "horizontal";
  /** The CSS custom property this sash resizes, e.g. "--sidebar-width". */
  variable: string;
  min: number;
  max: number;
  /** True when dragging right/down should SHRINK the value (panel from bottom). */
  invert?: boolean;
  /** Called once on release, so layout can be persisted without thrashing. */
  onCommit?: (value: number) => void;
}) {
  const start = useRef<{ pos: number; size: number } | null>(null);

  const read = (): number => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(variable);
    return Number.parseFloat(raw) || min;
  };

  return (
    <div
      className={"sash sash-" + orientation}
      role="separator"
      aria-orientation={orientation}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = {
          pos: orientation === "vertical" ? event.clientX : event.clientY,
          size: read(),
        };
        document.documentElement.classList.add("sashing");
      }}
      onPointerMove={(event) => {
        const from = start.current;
        if (!from) return;
        const now = orientation === "vertical" ? event.clientX : event.clientY;
        const delta = (now - from.pos) * (invert ? -1 : 1);
        const next = Math.min(max, Math.max(min, from.size + delta));
        document.documentElement.style.setProperty(variable, next + "px");
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        start.current = null;
        document.documentElement.classList.remove("sashing");
        onCommit?.(read());
      }}
    />
  );
}
