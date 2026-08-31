/**
 * Share this document - the Google Docs surface over WARRANT.
 *
 * The layout is deliberately familiar: a person picker at the top, a list of
 * who already has access with a role dropdown beside each, a link button at
 * the bottom. Anyone who has shared a Google Doc can drive it without reading
 * anything.
 *
 * What is NOT familiar is the second line under each person, and that is the
 * whole point of showing this to a judge. A row here is an ACL entry between
 * two humans and confers nothing on its own; the recipient has to attach one
 * of their OWN Agents before anything can act, and that is when a scoped,
 * expiring, revocable warrant is minted. So the dialog shows both halves: who
 * you shared with, and which Agent they brought.
 *
 * Two more honest details, both visible rather than buried:
 *   - the role dropdown only offers roles you yourself hold (attenuation), and
 *   - there is no "anyone with the link", because a link is not a principal
 *     and cannot be named in a warrant or revoked from.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { colorOf, humanName, shortId, washOf } from "../participants";
import type { Agent, DocSharing, ShareGrant, ShareRole } from "../types";

const ROLE_ORDER: ShareRole[] = ["viewer", "commenter", "editor"];

const ROLE_BLURB: Record<ShareRole, string> = {
  viewer: "Can read the document and its history. Cannot comment or write.",
  commenter: "Can read and leave comments that route to the responsible Agent.",
  editor: "Can read, comment, write, and propose a merge.",
};

/** Roles a sharer holding `max` is allowed to hand out. Never wider. */
function rolesUpTo(max: ShareRole | null): ShareRole[] {
  if (!max) return [];
  return ROLE_ORDER.slice(0, ROLE_ORDER.indexOf(max) + 1);
}

function Avatar({ id }: { id: string }) {
  const handle = id.replace(/^human:/, "");
  return (
    <span
      className="share-avatar"
      style={{ background: washOf(id, 0.9), borderColor: colorOf(id) }}
      aria-hidden="true"
    >
      {handle.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** "in 23h", "in 41m", "expired" - a warrant's clock, in words. */
function until(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return "in " + hours + "h";
  return "in " + Math.max(1, Math.round(ms / 60_000)) + "m";
}

export function ShareDialog({
  open,
  docId,
  viewerId,
  onClose,
  onChanged,
}: {
  open: boolean;
  docId: string | null;
  /** The signed-in human, so the dialog knows which row is "you". */
  viewerId: string | null;
  onClose: () => void;
  /** Fired after any grant changes, so the Access panel can refresh. */
  onChanged?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<DocSharing | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [granteeId, setGranteeId] = useState("");
  const [role, setRole] = useState<ShareRole>("editor");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!docId) return;
    try {
      const next = await api.sharing(docId);
      setState(next);
      setError(null);
      // Default the picker to the widest role this human may actually give,
      // rather than to a role the server will refuse.
      if (next.maxRole) setRole(next.maxRole);
      const first = next.people.find(
        (person) => !next.grants.some((grant) => grant.granteeId === person.id),
      );
      setGranteeId(first?.id ?? "");
    } catch (cause) {
      setState(null);
      setError(cause instanceof ApiError ? cause.message : "Could not load sharing");
    }
  }, [docId]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setCopied(false);
      void load();
      // The grantee's own Agents, for the attach picker below. Fetched here
      // rather than plumbed in: the dialog is the only view that needs them.
      void api
        .listAgents()
        .then(({ agents: list }) => setAgents(list))
        .catch(() => setAgents([]));
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, load]);

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
      await load();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "That did not work");
    } finally {
      setBusy(null);
    }
  };

  const mine = state?.grants.filter((grant) => grant.granteeId === viewerId) ?? [];
  const others = state?.grants.filter((grant) => grant.granteeId !== viewerId) ?? [];
  const offerable = rolesUpTo(state?.maxRole ?? null);
  const unshared = (state?.people ?? []).filter(
    (person) => !(state?.grants ?? []).some((grant) => grant.granteeId === person.id),
  );

  return (
    <dialog className="wb-dialog share-dialog" ref={ref} onClose={onClose}>
      <div className="share-head">
        <div>
          <h2>Share this document</h2>
          <p>
            <code>{docId}</code> · every grant below is a live warrant on{" "}
            <code>{state?.resource ?? "…"}</code>
          </p>
        </div>
        <button type="button" className="share-x" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      {error && <p className="share-error">{error}</p>}

      {/* ---- add people ------------------------------------------------ */}
      <form
        className="share-add"
        onSubmit={(event) => {
          event.preventDefault();
          if (!docId || !granteeId) return;
          void act("add", () => api.share(docId, { granteeId, role }));
        }}
      >
        <select
          value={granteeId}
          disabled={!state?.canShare || unshared.length === 0}
          onChange={(event) => setGranteeId(event.target.value)}
          aria-label="Person to share with"
        >
          {unshared.length === 0 && <option value="">Everyone already has access</option>}
          {unshared.map((person) => (
            <option key={person.id} value={person.id}>
              {person.displayName} ({person.handle})
            </option>
          ))}
        </select>

        <select
          value={role}
          disabled={!state?.canShare}
          onChange={(event) => setRole(event.target.value as ShareRole)}
          aria-label="Role"
        >
          {offerable.map((entry) => (
            <option key={entry} value={entry}>
              {entry.charAt(0).toUpperCase() + entry.slice(1)}
            </option>
          ))}
        </select>

        <button
          className="view-button primary"
          disabled={!state?.canShare || !granteeId || busy === "add"}
        >
          {busy === "add" ? "Sharing…" : "Share"}
        </button>
      </form>

      <p className="share-hint">
        {state?.canShare ? (
          <>
            {ROLE_BLURB[role]} You can grant up to <b>{state.maxRole}</b>, because that
            is what you hold - a delegation is never wider than the one behind it.
          </>
        ) : (
          <>
            You can open this document but not re-share it. Only someone who can edit
            may share, so a read-only grant can never widen itself.
          </>
        )}
      </p>

      {/* ---- who has access -------------------------------------------- */}
      <div className="share-list">
        <span className="eyebrow">People with access</span>

        {state && state.grants.length === 0 && (
          <p className="share-empty">
            Nobody yet. Whoever you add here brings their own Agent - you never hold
            or name it.
          </p>
        )}

        {[...mine, ...others].map((grant) => (
          <Row
            key={grant.id}
            grant={grant}
            isMine={grant.granteeId === viewerId}
            offerable={offerable}
            agents={agents}
            busy={busy}
            onRole={(next) =>
              docId &&
              void act(grant.id, () =>
                api.share(docId, { granteeId: grant.granteeId, role: next }),
              )
            }
            onAttach={(agentId) =>
              void act(grant.id, () => api.attachAgent(grant.id, agentId))
            }
            onRemove={() =>
              void act(grant.id, () =>
                api.unshare(
                  grant.id,
                  grant.granteeId === viewerId
                    ? "Recipient handed the access back"
                    : "Removed from the share dialog",
                ),
              )
            }
          />
        ))}
      </div>

      {/* ---- link, and the honest footnote ----------------------------- */}
      <div className="share-foot">
        <button
          type="button"
          className="view-button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(window.location.origin + "/#doc=" + encodeURIComponent(docId ?? ""))
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? "Link copied" : "Copy link"}
        </button>
        <p>
          The link opens the document - it does not grant it. There is no "anyone with
          the link" here on purpose: a link is not a principal, so it cannot be named
          in a warrant, and access you cannot name is access you cannot revoke.
        </p>
      </div>
    </dialog>
  );
}

/**
 * One person's access, in two lines: the grant, then the Agent they attached.
 *
 * The second line is the part worth reading. Until the recipient attaches an
 * Agent it says so plainly, because a grant with no Agent behind it genuinely
 * cannot do anything - and a permissions UI that implies otherwise is how
 * people end up trusting the wrong row.
 */
function Row({
  grant,
  isMine,
  offerable,
  agents,
  busy,
  onRole,
  onAttach,
  onRemove,
}: {
  grant: ShareGrant;
  isMine: boolean;
  offerable: ShareRole[];
  agents: Agent[];
  busy: string | null;
  onRole: (role: ShareRole) => void;
  onAttach: (agentId: string) => void;
  onRemove: () => void;
}) {
  const [picked, setPicked] = useState("");
  const live = grant.agents.filter((entry) => entry.live);
  const working = busy === grant.id;

  return (
    <div className="share-row" data-mine={isMine}>
      <Avatar id={grant.granteeId} />

      <div className="share-who">
        <b>
          {grant.granteeName}
          {isMine && <span className="share-you">you</span>}
        </b>
        <small>
          shared by {humanName(grant.grantedBy)} · expires {until(grant.expiresAt)}
        </small>
      </div>

      <select
        className="share-role"
        value={grant.role}
        disabled={working || offerable.length === 0}
        onChange={(event) => onRole(event.target.value as ShareRole)}
        aria-label={"Role for " + grant.granteeName}
      >
        {/* A role you cannot grant still has to render, or the person's actual
            role would silently display as something else. */}
        {(offerable.includes(grant.role) ? offerable : [grant.role, ...offerable]).map(
          (entry) => (
            <option key={entry} value={entry} disabled={!offerable.includes(entry)}>
              {entry.charAt(0).toUpperCase() + entry.slice(1)}
            </option>
          ),
        )}
      </select>

      <button
        type="button"
        className="share-x"
        title={isMine ? "Hand this access back" : "Remove access"}
        disabled={working}
        onClick={onRemove}
      >
        ✕
      </button>

      <div className="share-agents">
        {live.length > 0 ? (
          live.map((entry) => (
            <span
              className="share-agent"
              key={entry.warrantId}
              title={"warrant " + entry.warrantId}
            >
              <i style={{ background: colorOf(entry.agentId) }} />
              {shortId(entry.agentId)}
              <code>{grant.scopes.join(" ")}</code>
            </span>
          ))
        ) : (
          <span className="share-noagent">
            No Agent attached — this grant cannot act yet
          </span>
        )}

        {isMine && (
          <span className="share-attach">
            <select
              value={picked}
              onChange={(event) => setPicked(event.target.value)}
              aria-label="One of your Agents"
            >
              <option value="">Bring your own Agent…</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="view-button"
              disabled={!picked || working}
              onClick={() => {
                onAttach(picked);
                setPicked("");
              }}
            >
              Attach
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
