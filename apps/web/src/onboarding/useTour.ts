/**
 * Open/close state for the first-run tour, persisted so a returning visitor
 * is not shown it again.
 *
 * The step-by-step position lives inside <Tour> itself, not here - this hook
 * only answers "should the overlay be mounted at all", which is the one piece
 * of state a launcher button (or, later, a first-run check) needs to see.
 */

import { useCallback, useState } from "react";

export const TOUR_SEEN_KEY = "launchpad.onboarding.seen";

function readSeen(): boolean {
  try {
    return localStorage.getItem(TOUR_SEEN_KEY) === "1";
  } catch {
    // Private windows and blocked site data both throw here. Treat it the
    // same as "never seen" - worst case the tour offers itself again.
    return false;
  }
}

function writeSeen(): void {
  try {
    localStorage.setItem(TOUR_SEEN_KEY, "1");
  } catch {
    // Persisting is a convenience, not a requirement - the tour still closes.
  }
}

export function useTour(): {
  open: boolean;
  start: () => void;
  stop: () => void;
} {
  // FIRST-RUN TOGGLE: the tour is dev-button-launched only, for now. To make
  // it auto-open on a first visit instead, change the initializer below from
  // `useState(false)` to `useState(() => !readSeen())` - that is the one line
  // to flip. Everything else (the seen-key read/write, the try/catch) is
  // already wired for that switch.
  const [open, setOpen] = useState(false);

  const start = useCallback(() => setOpen(true), []);

  const stop = useCallback(() => {
    setOpen(false);
    writeSeen();
  }, []);

  return { open, start, stop };
}
