/**
 * Source Control, over CONCORD revisions.
 *
 * There is no git here and this view does not pretend there is. What it shows
 * is the thing this platform actually version-controls: one row per accepted
 * write, titled with the Agent's own `CONCORD-COMMIT:` line (concord/
 * checkpoint.ts), attributed to the Agent and the human it acts for, and
 * carrying the revision it moved the document from and to.
 *
 * It is the same information a git log carries - who changed what, when, and
 * why they said they did - which is why it reads as source control despite
 * being a different mechanism underneath. The view header says so in one line
 * rather than letting a judge assume git.
 */

import { useEffect, useState } from "react";
import { api } from "../api";
import type { AgentContribution, DocView, PendingConflict } from "../types";
import { Codicon } from "../shell/Codicon";
import { clockOf, colorOf, humanName, initialsOf, shortId } from "../participants";

export function SourceControlView({
  docId,
  agentId,
  version,
  conflicts,
  onOpenProblems,
}: {
  docId: string | null;
  agentId: string | null;
  /** Re-fetches when the revision moves, which is what makes this feel live. */
  version: number;
  conflicts: PendingConflict[];
  onOpenProblems: () => void;
}) {
  const [contributions, setContributions] = useState<AgentContribution[]>([]);
  const [history, setHistory] = useState<NonNullable<DocView["history"]>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!docId || !agentId) {
      setContributions([]);
      setHistory([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [log, past] = await Promise.all([
          api.contributions(docId, agentId),
          api.docHistory(docId, agentId),
        ]);
        if (cancelled) return;
        setContributions([...log.contributions].reverse());
        setHistory([...(past.history ?? [])].reverse());
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, agentId, version]);

  if (!docId) {
    return (
      <p className="panel-empty">
        Open a shared document to see what has been committed to it.
      </p>
    );
  }

  return (
    <>
      <p className="view-note">
        Revisions of <code>{docId}</code>. Each one is an accepted CONCORD write,
        named by the Agent that made it. This platform has no git — this is the
        history it does keep.
      </p>

      {error && <p className="panel-empty">{error}</p>}

      {conflicts.length > 0 && (
        <>
          <div className="view-section">Merge changes</div>
          {conflicts.map((conflict) => (
            <button key={conflict.id} className="tree-row" onClick={onOpenProblems}>
              <Codicon name="warning" />
              <span className="tree-name">
                Contested by {shortId(conflict.agentId)} at rev {conflict.atVersion}
              </span>
              <span className="tree-meta">{conflict.conflicts.length}</span>
            </button>
          ))}
        </>
      )}

      <div className="view-section">
        Commits <span className="activity-badge">{contributions.length}</span>
      </div>

      {contributions.length === 0 && (
        <p className="panel-empty">
          Nothing committed yet. An Agent's turn, or a human's save, lands here.
        </p>
      )}

      {contributions.map((entry) => (
        <div className="commit-row" key={entry.id}>
          <span
            className="avatar sm"
            style={{ background: colorOf(entry.humanId ?? entry.agentId) }}
            title={entry.agentId}
          >
            {initialsOf(entry.humanId ?? entry.agentId, null)}
          </span>
          <div className="commit-body">
            <span className="commit-summary">{entry.summary}</span>
            <span className="commit-meta">
              {humanName(entry.humanId)} · {shortId(entry.agentId)} ·{" "}
              {clockOf(entry.createdAt)}
            </span>
            <span className="commit-meta">
              rev {entry.baseVersion} → {entry.resultingVersion} ·{" "}
              {entry.changedLineIds.length} line
              {entry.changedLineIds.length === 1 ? "" : "s"}
              {entry.outcome === "merged" && (
                <span className="commit-tag" title="Folded in with another Agent's edit">
                  merged
                </span>
              )}
            </span>
          </div>
        </div>
      ))}

      {history.length > 0 && (
        <>
          <div className="view-section">Timeline</div>
          {history.map((entry) => (
            <div className="tree-row" key={entry.version}>
              <Codicon name="git-commit" />
              <span className="tree-name">rev {entry.version}</span>
              <span className="tree-meta">
                {humanName(entry.humanId)} · {clockOf(entry.at)}
              </span>
            </div>
          ))}
        </>
      )}
    </>
  );
}
