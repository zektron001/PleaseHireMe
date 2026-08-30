import { useState } from "react";
import { api } from "./api";
import type { ReviewComment, ReviewState } from "./types";

/**
 * The review surface: comment on selected lines, send comments back to the
 * Agent that wrote them, and watch what CONCORD decided.
 *
 * Every status shown here comes from a backend record. Nothing is optimistic:
 * a comment reads "addressed" only because a re-iteration run reported that
 * CONCORD accepted the revision, and "conflict" only because CONCORD refused it.
 */

const STATUS_LABEL: Record<string, string> = {
  open: "open",
  in_progress: "agent working",
  addressed: "addressed — needs your review",
  resolved: "resolved",
  stale: "stale — code moved",
  conflict: "conflict — canonical code kept",
  failed: "failed",
};

export function shortAgent(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + "…" : id;
}

export function ReviewPanel({
  docId,
  state,
  selection,
  busy,
  onRefresh,
  onError,
  onClearSelection,
}: {
  docId: string | null;
  state: ReviewState | null;
  selection: { start: number; end: number } | null;
  busy: boolean;
  onRefresh: () => void;
  onError: (message: string) => void;
  onClearSelection: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  if (!docId) return null;
  const comments = state?.comments ?? [];
  const open = comments.filter(
    (comment) => comment.status !== "resolved" && comment.status !== "stale",
  );

  const submit = async () => {
    if (!selection || !draft.trim()) return;
    try {
      await api.addComment(docId, {
        startLine: selection.start,
        endLine: selection.end,
        body: draft.trim(),
        ...(target ? { targetAgentId: target } : {}),
      });
      setDraft("");
      setTarget("");
      onClearSelection();
      onRefresh();
    } catch (error) {
      // An ambiguous range is a real backend answer, not a UI failure: the
      // reviewer is asked to choose rather than having one picked for them.
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const toggle = (id: string) => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const send = async () => {
    if (chosen.size === 0) return;
    try {
      await api.reiterate([...chosen]);
      setChosen(new Set());
      onRefresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="review">
      <div className="review-head">
        <b>Review</b>
        <span className="review-count">{open.length} open</span>
      </div>

      {selection ? (
        <div className="review-compose">
          <div className="review-range">
            Lines {selection.start}
            {selection.end !== selection.start ? "–" + selection.end : ""}
          </div>
          <textarea
            className="review-input"
            rows={3}
            value={draft}
            placeholder="What should the responsible Agent change?"
            onChange={(event) => setDraft(event.target.value)}
          />
          <input
            className="review-input"
            value={target}
            placeholder="Agent id (only if several wrote these lines)"
            onChange={(event) => setTarget(event.target.value)}
          />
          <div className="review-actions">
            <button className="ghost" onClick={onClearSelection}>
              Cancel
            </button>
            <button disabled={busy || !draft.trim()} onClick={() => void submit()}>
              Add review comment
            </button>
          </div>
        </div>
      ) : (
        <p className="review-hint">
          Select one or more lines in the document to leave a comment. It is routed
          to the Agent that last changed them.
        </p>
      )}

      {open.length > 0 && (
        <div className="review-actions review-bulk">
          <span className="review-hint">{chosen.size} selected</span>
          <button disabled={busy || chosen.size === 0} onClick={() => void send()}>
            Reiterate selected comments
          </button>
        </div>
      )}

      <ul className="review-list">
        {comments.map((comment) => (
          <CommentRow
            key={comment.id}
            comment={comment}
            checked={chosen.has(comment.id)}
            busy={busy}
            onToggle={() => toggle(comment.id)}
            onResolve={() => {
              void api
                .resolveComment(comment.id)
                .then(onRefresh)
                .catch((error: unknown) =>
                  onError(error instanceof Error ? error.message : String(error)),
                );
            }}
          />
        ))}
        {comments.length === 0 && <li className="review-hint">No comments yet.</li>}
      </ul>

      {(state?.events.length ?? 0) > 0 && (
        <>
          <div className="review-head">
            <b>Review activity</b>
          </div>
          <ul className="review-list">
            {state?.events.slice(0, 12).map((event) => (
              <li key={event.id} className="review-event">
                <span className={"review-dot " + event.actorType} />
                <span>{event.summary}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function CommentRow({
  comment,
  checked,
  busy,
  onToggle,
  onResolve,
}: {
  comment: ReviewComment;
  checked: boolean;
  busy: boolean;
  onToggle: () => void;
  onResolve: () => void;
}) {
  const selectable = comment.status === "open" || comment.status === "addressed";
  return (
    <li className={"review-item status-" + comment.status}>
      <div className="review-item-head">
        {selectable ? (
          <input type="checkbox" checked={checked} onChange={onToggle} disabled={busy} />
        ) : (
          <span className="review-checkbox-gap" />
        )}
        <span className="review-lines">
          L{comment.startLine}
          {comment.endLine !== comment.startLine ? "–" + comment.endLine : ""}
        </span>
        <span className="review-agent">{shortAgent(comment.responsibleAgentId)}</span>
        <span className="review-status">
          {STATUS_LABEL[comment.status] ?? comment.status}
        </span>
      </div>
      <p className="review-body">{comment.body}</p>
      {comment.status === "stale" && (
        <p className="review-warn">
          The code moved after this was written. Select the updated lines and
          comment again — it will not be sent to an Agent as it stands.
        </p>
      )}
      {comment.status === "conflict" && (
        <p className="review-warn">
          CONCORD refused the revision; the canonical code was not overwritten.
        </p>
      )}
      {comment.status !== "resolved" && (
        <button className="ghost review-resolve" disabled={busy} onClick={onResolve}>
          Resolve
        </button>
      )}
    </li>
  );
}
