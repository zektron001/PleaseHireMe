/**
 * "Shared with me" - the recipient's half of sharing.
 *
 * The share dialog is where you give access away. This is where you find out
 * you were given some, and it exists because the dialog cannot serve that
 * job: to open it you already have to know which document to open, which is
 * exactly what a recipient does not know yet.
 *
 * It is also the only place the two-phase design is actionable from. A grant
 * on its own authorises nothing - the authority appears when the recipient
 * attaches one of their OWN Agents and a warrant is minted for it. So the
 * primary control on every row is that attach picker, and a row with nothing
 * attached says plainly that it cannot act.
 */

import { useCallback, useEffect, useState, type JSX } from "react";
import { api, ApiError } from "../api";
import { colorOf, humanName, shortId } from "../participants";
import type { Agent, ShareGrant } from "../types";

/** "in 23h", "in 41m", "expired" - a warrant's clock, in words. */
function until(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return "in " + hours + "h";
  return "in " + Math.max(1, Math.round(ms / 60_000)) + "m";
}

export function SharedWithMe({
  onOpenDoc,
  onChanged,
}: {
  /** Opening the document is the whole reason someone reads this list. */
  onOpenDoc: (docId: string) => void;
  /** Attaching an Agent mints a warrant, so the Access panel goes stale. */
  onChanged?: () => void;
}): JSX.Element | null {
  const [grants, setGrants] = useState<ShareGrant[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [mine, list] = await Promise.all([api.sharedWithMe(), api.listAgents()]);
      setGrants(mine.grants);
      setAgents(list.agents);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not load shares");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const attach = async (grantId: string, agentId: string) => {
    setBusy(grantId);
    try {
      await api.attachAgent(grantId, agentId);
      await load();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not attach that Agent");
    } finally {
      setBusy(null);
    }
  };

  const handBack = async (grantId: string) => {
    setBusy(grantId);
    try {
      await api.unshare(grantId, "Recipient handed the access back");
      await load();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not remove that share");
    } finally {
      setBusy(null);
    }
  };

  // Nothing shared and nothing broken is not worth a heading - the Access
  // panel below already explains itself.
  if (grants.length === 0 && !error) return null;

  return (
    <div className="inbox">
      <div className="inbox-head">
        <span className="eyebrow">Shared with me</span>
        <span className="inbox-count">{grants.length}</span>
      </div>

      {error && <p className="share-error">{error}</p>}

      {grants.map((grant) => {
        const live = grant.agents.filter((entry) => entry.live);
        const working = busy === grant.id;
        return (
          <div className="inbox-row" key={grant.id} data-armed={live.length > 0}>
            <button
              type="button"
              className="inbox-doc"
              onClick={() => onOpenDoc(grant.docId)}
              title={"Open " + grant.docId}
            >
              {grant.docId}
            </button>

            <div className="inbox-meta">
              <span className={"badge role-" + grant.role}>{grant.role}</span>
              <span>
                from {humanName(grant.grantedBy)} · expires {until(grant.expiresAt)}
              </span>
            </div>

            {live.length > 0 ? (
              <>
                <div className="inbox-agents">
                  {live.map((entry) => (
                    <span className="share-agent" key={entry.warrantId} title={"warrant " + entry.warrantId}>
                      <i style={{ background: colorOf(entry.agentId) }} />
                      {shortId(entry.agentId)}
                    </span>
                  ))}
                </div>
                {/* The same badge the warrant list below uses. Four scopes
                    crammed into the chip itself wrapped into an unreadable
                    block at sidebar width. */}
                <div className="inbox-scopes">
                  {grant.scopes.map((scope) => (
                    <span className="scope" key={scope}>
                      {scope}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="inbox-arm">
                Nothing can act on this yet. Attach one of your own Agents and a
                scoped warrant is minted for it.
              </p>
            )}

            <Attach
              agents={agents}
              busy={working}
              label={live.length > 0 ? "Add another…" : "Choose an Agent…"}
              onAttach={(agentId) => void attach(grant.id, agentId)}
            />

            <button
              type="button"
              className="ghost inbox-return"
              disabled={working}
              onClick={() => void handBack(grant.id)}
            >
              Hand access back
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The picker plus its button, kept separate so each row owns its selection. */
function Attach({
  agents,
  busy,
  label,
  onAttach,
}: {
  agents: Agent[];
  busy: boolean;
  label: string;
  onAttach: (agentId: string) => void;
}) {
  const [picked, setPicked] = useState("");
  return (
    <span className="share-attach">
      <select
        value={picked}
        onChange={(event) => setPicked(event.target.value)}
        aria-label="One of your Agents"
      >
        <option value="">{label}</option>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="view-button"
        disabled={!picked || busy}
        onClick={() => {
          onAttach(picked);
          setPicked("");
        }}
      >
        Attach
      </button>
    </span>
  );
}
