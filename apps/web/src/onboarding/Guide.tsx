/**
 * The guided path through one full task.
 *
 * Not a tour: the tour is a linear thing you sit through once. This reads the
 * real state of the workbench and says the one next thing to do, so somebody
 * who has never seen the app can get from signing in to a merged document
 * without being told what any of it means first.
 *
 * Every step points at an element carrying a `data-guide` id. If that element
 * is not on screen the step still shows its text, because being told what to do
 * next is useful even when the thing to click is one panel away.
 */

import { useEffect, useState } from "react";
import type { BoardSession, Human } from "../types";

export interface GuideState {
  /** Null until a human is signed in. */
  readonly me: Human | null;
  readonly humans: readonly Human[];
  readonly session: BoardSession | null;
  readonly view: string;
  readonly panel: string;
  /** True once a document is open in the editor. */
  readonly hasOpenDoc: boolean;
  readonly merged: boolean;
}

export interface GuideStep {
  readonly id: string;
  /** `data-guide` id of the element to ring, or null for advice with no target. */
  readonly target: string | null;
  readonly title: string;
  readonly body: string;
  /** Shown as a quiet "why" line under the instruction. */
  readonly why?: string;
  readonly tone?: "normal" | "done";
}

const OPERATOR = "orchestrator";

/** The single next thing to do, derived from what is actually on screen. */
export function nextStep(state: GuideState): GuideStep | null {
  const { me, session } = state;

  if (!me) {
    return {
      id: "sign-in",
      target: "signin-operator",
      title: "Sign in as You",
      body:
        'Click "You" at the top right. That is the orchestrator: the one who ' +
        "splits the work and merges it at the end.",
      why: "Every view here is scoped to the delegations you actually hold.",
    };
  }

  if (!session) {
    return {
      id: "split",
      target: "split-it",
      title: "Describe a task, then split it",
      body:
        'A task and the file everyone shares are already filled in. Press "Split it" ' +
        "to fan the task out into subtasks.",
      why: "One Agent per subtask, each under a scoped warrant issued by the backend.",
    };
  }

  const agents = session.agents ?? [];
  const mine = agents.find((a) => a.mine);
  const theirs = agents.find((a) => !a.mine);
  const ownerOf = (id: string) => id.replace(/^human:/, "");
  const anyRunning = (session.running ?? 0) > 0;
  const ranOnce = agents.some((a) => a.turns > 0);
  const allSubmitted =
    agents.length > 0 &&
    agents.every((a) => ["submitted", "approved", "integrated"].includes(a.state));
  const allApproved =
    agents.length > 0 &&
    agents.every((a) => ["approved", "integrated"].includes(a.state));

  if (state.merged || agents.every((a) => a.state === "integrated")) {
    if (agents.length > 0) {
      return {
        id: "merged",
        target: "editor-surface",
        title: "Merged — and it is yours to edit",
        body:
          "This is the finished document, every section written by a different Agent. " +
          "Click into it and type: your edits go through the same write path theirs did.",
        why: "The human is exempt from section ownership. The whole file is yours.",
        tone: "done",
      };
    }
  }

  // On the dashboard the task is a card you have to open before anything else.
  if (state.view === "dashboard") {
    return {
      id: "open-session",
      target: "session-card",
      title: "Open the task",
      body: "Click the task card to open it. That is where the Agents are.",
      why: "It opens on the Agents board - who is on this task, and what they own.",
    };
  }

  if (anyRunning) {
    return {
      id: "watch",
      target: "view-screens",
      title: "An Agent is working — watch it",
      body:
        'Click the ▶ header above the editor for the live screens: each Agent\'s own ' +
        "copy of the file, changing as it writes.",
      why: "Polled from the real workspace on disk, not an animation.",
    };
  }

  if (!ranOnce) {
    return {
      id: "run",
      target: "run-task",
      title: mine ? "Run your Agent: " + mine.title : "This Agent is not yours to run",
      body: mine
        ? 'Press "▶ Run task" on the card marked Yours — "' + mine.title + '".' +
          (theirs
            ? ' The other card is ' + ownerOf(theirs.ownerId) + "'s; running it is refused."
            : "")
        : "Every Agent here acts for someone else. Sign in as " +
          (theirs ? ownerOf(theirs.ownerId) : "the other human") +
          " at the top right to run theirs.",
      why: "Same button, different principal, different answer.",
    };
  }

  if (allApproved && session.readyToIntegrate) {
    return {
      id: "merge",
      target: "merge-all",
      title: "Everything is approved — merge it",
      body: 'The gate is open. Press "⑃ Merge all work" to combine every Agent\'s work.',
      why: "The orchestrator combines; it never had authority over any workspace.",
      tone: "done",
    };
  }

  if (allSubmitted) {
    return {
      id: "approve",
      target: "approve-agent",
      title: "Every Agent is finished — approve their work",
      body: mine
        ? 'Press "Approve" on your card ("' + mine.title + '").' +
          (theirs
            ? " Then sign in as " + ownerOf(theirs.ownerId) + " to approve theirs."
            : "")
        : "Sign in as " +
          (theirs ? ownerOf(theirs.ownerId) : "each owner") +
          " to approve their own Agent's work.",
      why: "The merge stays shut until every Agent is approved.",
    };
  }

  if (!state.hasOpenDoc) {
    return {
      id: "open-doc",
      target: "explorer-doc",
      title: "Open the shared file",
      body:
        "In the Explorer on the left, click the document. It is the one file every " +
        "Agent here is writing into.",
      why: "Turn on blame to see which Agent wrote each line.",
    };
  }

  return {
    id: "consult",
    target: "consult-hint",
    title: "Ask about a line",
    body:
      "Select any line in the editor. A review box opens on the right where you can " +
      "comment, or ask the Agent that wrote it to explain itself.",
    why: "The comment is routed by provenance, not by you choosing a name.",
  };
}

/** Rings the target element and parks the callout near it. */
function useTargetRect(target: string | null): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!target) {
      setRect(null);
      return;
    }
    let raf = 0;
    const measure = () => {
      const el = document.querySelector<HTMLElement>(`[data-guide="${target}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
      raf = window.requestAnimationFrame(measure);
    };
    measure();
    return () => window.cancelAnimationFrame(raf);
  }, [target]);
  return rect;
}

export function Guide({
  state,
  dismissed,
  onDismiss,
}: {
  state: GuideState;
  dismissed: boolean;
  onDismiss: () => void;
}) {
  const step = dismissed ? null : nextStep(state);
  const rect = useTargetRect(step?.target ?? null);
  if (!step) return null;

  return (
    <>
      {rect && (
        <div
          className="guide-ring"
          style={{
            left: rect.left - 6,
            top: rect.top - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      )}
      <aside
        className="guide-card"
        data-tone={step.tone ?? "normal"}
        role="status"
        aria-live="polite"
      >
        <div className="guide-head">
          <span className="guide-kicker">Next</span>
          <button className="guide-dismiss" onClick={onDismiss} title="Hide the guide">
            ×
          </button>
        </div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        {step.why && <p className="guide-why">{step.why}</p>}
      </aside>
    </>
  );
}

export { OPERATOR };
