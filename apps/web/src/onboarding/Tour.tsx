/**
 * The first-run tour: a dimmed backdrop with a spotlight cutout over one real
 * workbench element per step, plus a callout card that repositions itself to
 * stay on screen. Classic technique - a fixed-position, transparent element
 * sized to the target with `box-shadow: 0 0 0 9999px <dim>` around it, which
 * paints the "everything except this rect" dimming without a second scrim
 * layer to keep in sync.
 *
 * The wrapping `.tour` element is the one thing on top of the workbench, so
 * it is also the one thing that needs to capture every click - nothing below
 * it should be reachable while the tour is open. That is simpler than trying
 * to make the spotlight's own box swallow clicks: the parent already covers
 * the full viewport by default.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from "react";
import { TOUR_STEPS, type TourStep } from "./steps";
import "./tour.css";

interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Point {
  readonly top: number;
  readonly left: number;
}

/** Gap between the spotlight and the card, and the card and the viewport edge. */
const CARD_GAP = 18;
const VIEWPORT_MARGIN = 16;
/** Padding the hole gets beyond the target's own box, so it reads as a spotlight, not a trace. */
const HOLE_PADDING = 8;
/**
 * Frames to keep looking for a missing target before giving up and treating
 * the step as a centered card instead. ~0.65s at 60fps - generous enough for
 * `onReveal` to flip a panel open and React to re-render, short enough that a
 * genuinely absent element (see the contract note on `onReveal`) does not
 * leave the tour stalled.
 */
const RESOLVE_ATTEMPTS = 40;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function sameRect(a: Rect | null, b: DOMRect): boolean {
  return a !== null && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

function centerOf(size: Size, viewport: Size): Point {
  return {
    top: viewport.height / 2 - size.height / 2,
    left: viewport.width / 2 - size.width / 2,
  };
}

/**
 * Picks a side of the spotlight with room for the card - below first, since
 * that is how a reader's eye already moves, then above, then right, then
 * left - and clamps the result so the card never runs off the viewport even
 * when nothing fits cleanly.
 */
function placeCard(rect: Rect, card: Size, viewport: Size): Point {
  const below = rect.top + rect.height + CARD_GAP;
  const above = rect.top - CARD_GAP - card.height;
  const right = rect.left + rect.width + CARD_GAP;
  const left = rect.left - CARD_GAP - card.width;

  let top: number;
  let cardLeft: number;

  if (below + card.height <= viewport.height - VIEWPORT_MARGIN) {
    top = below;
    cardLeft = rect.left + rect.width / 2 - card.width / 2;
  } else if (above >= VIEWPORT_MARGIN) {
    top = above;
    cardLeft = rect.left + rect.width / 2 - card.width / 2;
  } else if (right + card.width <= viewport.width - VIEWPORT_MARGIN) {
    top = rect.top + rect.height / 2 - card.height / 2;
    cardLeft = right;
  } else if (left >= VIEWPORT_MARGIN) {
    top = rect.top + rect.height / 2 - card.height / 2;
    cardLeft = left;
  } else {
    // Nothing fits cleanly - a target spanning most of a small viewport.
    // Overlay it, still clamped, rather than pointing the card off-screen.
    top = below;
    cardLeft = rect.left + rect.width / 2 - card.width / 2;
  }

  return {
    top: clamp(top, VIEWPORT_MARGIN, viewport.height - card.height - VIEWPORT_MARGIN),
    left: clamp(cardLeft, VIEWPORT_MARGIN, viewport.width - card.width - VIEWPORT_MARGIN),
  };
}

/**
 * Tracks the on-screen rect of the current step's `data-tour` target. Polls
 * every animation frame rather than wiring scroll/resize listeners - cheap
 * for the handful of seconds a tour step is open, and it means a sidebar
 * drag or a scroll just falls out of the same loop instead of needing its
 * own handler. Gives up after `RESOLVE_ATTEMPTS` frames and reports a
 * resolved-but-missing target, which the caller renders as a centered card.
 */
function useSpotlightRect(
  open: boolean,
  targetId: string | null,
): { rect: Rect | null; resolved: boolean } {
  const [rect, setRect] = useState<Rect | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRect(null);
    setResolved(targetId === null);
    if (targetId === null) return;

    let raf = 0;
    let cancelled = false;
    let attempts = 0;
    let found = false;

    const tick = () => {
      if (cancelled) return;
      const el = document.querySelector('[data-tour="' + targetId + '"]');
      const box = el ? el.getBoundingClientRect() : null;
      if (box && box.width > 0 && box.height > 0) {
        found = true;
        setRect((prev) =>
          sameRect(prev, box)
            ? prev
            : { top: box.top, left: box.left, width: box.width, height: box.height },
        );
        setResolved(true);
        raf = requestAnimationFrame(tick);
        return;
      }
      if (!found) {
        attempts += 1;
        if (attempts > RESOLVE_ATTEMPTS) {
          // Give up - stay resolved-but-null, which renders as a centered card.
          setResolved(true);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [open, targetId]);

  return { rect, resolved };
}

export function Tour({
  open,
  onClose,
  onReveal,
}: {
  open: boolean;
  onClose: () => void;
  /** Called when a step wants the workbench to reveal something, e.g. focus a
   *  sidebar panel. Ids match the `data-tour` ids above. I handle it. */
  onReveal?: (target: string) => void;
}): JSX.Element | null {
  const [stepIndex, setStepIndex] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Point | null>(null);

  // Every open is a fresh run of the tour, not a resume of wherever it was
  // left - a dev button (or later, first run) always starts at chapter one.
  useEffect(() => {
    if (open) setStepIndex(0);
  }, [open]);

  const step: TourStep | undefined = TOUR_STEPS[stepIndex];
  const targetId = step && step.target !== null ? step.target : null;

  useEffect(() => {
    if (!open || targetId === null) return;
    onReveal?.(targetId);
  }, [open, targetId, onReveal]);

  const { rect, resolved } = useSpotlightRect(open, targetId);

  useLayoutEffect(() => {
    if (!resolved) return;
    const compute = () => {
      const cardEl = cardRef.current;
      if (!cardEl) return;
      const size = { width: cardEl.offsetWidth, height: cardEl.offsetHeight };
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      setPos(rect ? placeCard(rect, size, viewport) : centerOf(size, viewport));
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [rect, resolved]);

  const total = TOUR_STEPS.length;
  const isFirst = stepIndex === 0;
  const isLast = stepIndex >= total - 1;

  const back = useCallback(() => {
    setStepIndex((index) => Math.max(0, index - 1));
  }, []);

  const next = useCallback(() => {
    setStepIndex((index) => {
      if (index >= total - 1) return index;
      return index + 1;
    });
  }, [total]);

  // Escape and the arrow keys work anywhere while the tour is open, not just
  // when a button happens to have focus - a spotlight tour is a full-screen
  // modal in every way that matters.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (isLast) onClose();
        else next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, next, back, isLast]);

  // Land keyboard focus on the card itself each step, rather than leaving it
  // wherever the workbench last had it - `tabIndex={-1}` makes a plain div a
  // valid, programmatic focus target without also making it tab-reachable.
  useEffect(() => {
    if (open && pos) cardRef.current?.focus();
  }, [open, pos, stepIndex]);

  if (!open || !step) return null;

  const holeStyle = rect
    ? {
        top: rect.top - HOLE_PADDING,
        left: rect.left - HOLE_PADDING,
        width: rect.width + HOLE_PADDING * 2,
        height: rect.height + HOLE_PADDING * 2,
      }
    : null;

  return (
    <div className="tour">
      {holeStyle ? (
        <div className="tour-hole" style={holeStyle} />
      ) : (
        <div className="tour-scrim" />
      )}

      {pos && (
        <div
          key={step.id}
          className="tour-card"
          style={{ top: pos.top, left: pos.left }}
          ref={cardRef}
          role="dialog"
          aria-modal="true"
          aria-label={step.title}
          aria-live="polite"
          tabIndex={-1}
        >
          <button className="tour-close" onClick={onClose} aria-label="Close tour">
            <span aria-hidden="true">×</span>
          </button>

          <div className="tour-chapter">
            <div className="tour-dots" aria-hidden="true">
              {([1, 2, 3, 4] as const).map((chapter) => (
                <span
                  key={chapter}
                  className="tour-dot"
                  data-state={
                    chapter < step.chapter ? "done" : chapter === step.chapter ? "active" : "upcoming"
                  }
                />
              ))}
            </div>
            <span>
              Chapter {step.chapter} of 4 · {step.chapterTitle}
            </span>
          </div>

          <h2 className="tour-title">{step.title}</h2>
          {step.body.map((paragraph, index) => (
            <p className="tour-body" key={step.id + "-p" + index}>
              {paragraph}
            </p>
          ))}

          <div className="tour-progress">
            <div className="tour-progress-bar">
              <div
                className="tour-progress-fill"
                style={{ width: ((stepIndex + 1) / total) * 100 + "%" }}
              />
            </div>
            <span className="tour-progress-text">
              {stepIndex + 1} of {total}
            </span>
          </div>

          <div className="tour-footer">
            <button className="tour-skip" onClick={onClose}>
              Skip tour
            </button>
            <div className="tour-nav">
              <button className="tour-back" onClick={back} disabled={isFirst}>
                Back
              </button>
              <button className="tour-next" onClick={isLast ? onClose : next}>
                {isLast ? "Finish" : "Next"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
