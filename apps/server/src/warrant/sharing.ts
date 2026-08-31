/**
 * Sharing - the Google Docs surface over WARRANT.
 *
 * The mental model a developer already has is "share this doc with Bob, as an
 * Editor". The mental model this platform enforces is "issue Bob's Agent a
 * scoped, expiring, revocable warrant over repo:<path>". This module is the one
 * place those two meet, and it is deliberately thin: it decides WHO may share
 * WHAT, then hands the actual authority question back to the PDP untouched.
 *
 * Three rules carry the whole design.
 *
 *   1. Attenuation. You cannot grant what you do not hold. The scopes behind a
 *      role are checked against the scopes the sharer actually holds on that
 *      document, so a re-share can only ever narrow. There is no "owner" flag
 *      to escalate through, because there is no owner table - authority is read
 *      back out of live warrants every time.
 *
 *   2. Only writers may share. Mirrors the Google Docs default. A Viewer who
 *      could re-share would be a privilege-escalation path dressed as a
 *      convenience.
 *
 *   3. A grant is not authority. It is an ACL entry naming two humans. Nothing
 *      can act until the GRANTEE attaches one of their own Agents and a warrant
 *      is minted for it. That is what "bring your own Agent" means here: the
 *      sharer never names, holds, or can impersonate the Agent that ends up
 *      doing the work.
 *
 * What is not here, on purpose: "anyone with the link". A link is not a
 * principal. It cannot appear in a warrant's five-tuple, and a grant whose
 * holder cannot be named cannot be revoked from them. The share dialog says so
 * rather than quietly omitting it.
 */

import { randomUUID } from "node:crypto";
import { docResource } from "../concord/store.js";
import { covers } from "./resources.js";
import type { Registry } from "./registry.js";
import {
  SCOPES_FOR_ROLE,
  type ShareGrant,
  type ShareRole,
  type Warrant,
  type WarrantScope,
} from "./types.js";

/** Grants outlive a single warrant, so they get their own, longer default. */
export const DEFAULT_GRANT_TTL_MS = 86_400_000;

export type ShareRefusal =
  | "not-a-writer"
  | "exceeds-holdings"
  | "self-share"
  | "unknown-grantee";

export interface ShareDecision {
  readonly allowed: boolean;
  readonly ruleId: string;
  readonly reason: string;
  readonly refusal?: ShareRefusal;
}

/**
 * The scopes a human actually holds on one document, unioned across every live
 * warrant of theirs that covers it.
 *
 * Read live rather than cached: a warrant that expired a second ago must stop
 * conferring the right to share a second ago, not at the next cache sweep.
 */
export function heldScopes(
  registry: Registry,
  humanId: string,
  docId: string,
): Set<WarrantScope> {
  const resource = docResource(docId);
  const held = new Set<WarrantScope>();
  for (const warrant of registry.liveWarrantsForHuman(humanId)) {
    if (!warrant.resources.some((granted) => covers(granted, resource))) continue;
    for (const scope of warrant.scopes) held.add(scope);
  }
  return held;
}

/** The widest role a human could share this document at. Null when none. */
export function maxShareableRole(
  registry: Registry,
  humanId: string,
  docId: string,
): ShareRole | null {
  const held = heldScopes(registry, humanId, docId);
  if (!held.has("workspace:write")) return null;
  const roles: ShareRole[] = ["editor", "commenter", "viewer"];
  return (
    roles.find((role) =>
      SCOPES_FOR_ROLE[role].every((scope) => held.has(scope)),
    ) ?? null
  );
}

/**
 * May this human share this document at this role?
 *
 * Returns a decision rather than a boolean so the caller can put the reason in
 * the audit chain and in front of the user. A denial nobody can read is a
 * denial nobody can fix.
 */
export function canShare(
  registry: Registry,
  granterId: string,
  granteeId: string,
  docId: string,
  role: ShareRole,
): ShareDecision {
  if (granterId === granteeId) {
    return {
      allowed: false,
      ruleId: "WB-13.share-self",
      reason: "You already hold this document; sharing it with yourself is a no-op",
      refusal: "self-share",
    };
  }
  if (!registry.human(granteeId)) {
    return {
      allowed: false,
      ruleId: "WB-13.share-unknown-grantee",
      reason: "No such person: " + granteeId,
      refusal: "unknown-grantee",
    };
  }

  const held = heldScopes(registry, granterId, docId);
  if (!held.has("workspace:write")) {
    return {
      allowed: false,
      ruleId: "WB-14.share-requires-write",
      reason:
        "Only someone who can edit this document may share it; you hold " +
        ([...held].join(", ") || "nothing") +
        " on " +
        docResource(docId),
      refusal: "not-a-writer",
    };
  }

  const wanted = SCOPES_FOR_ROLE[role];
  const missing = wanted.filter((scope) => !held.has(scope));
  if (missing.length > 0) {
    return {
      allowed: false,
      ruleId: "WB-15.share-exceeds-holdings",
      reason:
        "A delegation cannot be wider than the one behind it; " +
        role +
        " needs " +
        missing.join(", ") +
        ", which you do not hold",
      refusal: "exceeds-holdings",
    };
  }

  return {
    allowed: true,
    ruleId: "WB-0.share-within-holdings",
    reason:
      granterId + " holds " + role + " or wider on " + docResource(docId),
  };
}

/**
 * The grant store.
 *
 * In memory, like the rest of the WARRANT plane in this POC. The shape is
 * deliberately the shape a table would have, so persistence is a swap rather
 * than a redesign.
 */
export class ShareRegistry {
  private readonly grants = new Map<string, ShareGrant>();

  constructor(
    private readonly registry: Registry,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Records the ACL entry. Mints nothing: see the module header, rule 3.
   *
   * Re-sharing the same document with the same person REPLACES the previous
   * grant rather than stacking a second one, and revokes the warrants the old
   * one minted. Otherwise "change Bob to Viewer" would leave his Editor
   * warrant live underneath the new row, which is exactly the bug that makes
   * permission UIs untrustworthy.
   */
  grant(input: {
    docId: string;
    grantedBy: string;
    granteeId: string;
    role: ShareRole;
    ttlMs?: number;
  }): ShareGrant {
    const existing = this.forDocAndGrantee(input.docId, input.granteeId);
    if (existing) {
      this.revoke(existing.id, "Replaced by a new grant at " + input.role);
    }

    const issuedAt = this.now();
    const grant: ShareGrant = {
      id: "shr_" + randomUUID(),
      docId: input.docId,
      grantedBy: input.grantedBy,
      granteeId: input.granteeId,
      role: input.role,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(
        issuedAt + (input.ttlMs ?? DEFAULT_GRANT_TTL_MS),
      ).toISOString(),
      agentWarrantIds: [],
      revokedAt: null,
      revokedReason: null,
    };
    this.grants.set(grant.id, grant);
    return grant;
  }

  /**
   * The grantee attaches one of their own Agents, and only now does authority
   * exist. The warrant is scoped to exactly one resource - the shared document
   * - and expires with the grant rather than on its own schedule, so a grant
   * cannot outlive itself through a warrant it minted.
   */
  attachAgent(grantId: string, agentId: string): Warrant | null {
    const grant = this.grants.get(grantId);
    if (!grant || !this.isLive(grant)) return null;

    const existing = grant.agentWarrantIds
      .map((id) => this.registry.warrant(id))
      .find((warrant) => warrant?.agentId === agentId && this.registry.isLive(warrant));
    if (existing) return existing;

    const warrant = this.registry.issue({
      humanId: grant.granteeId,
      agentId,
      subtaskId: grant.id,
      origin: "share",
      grantedBy: grant.grantedBy,
      scopes: SCOPES_FOR_ROLE[grant.role],
      resources: [docResource(grant.docId)],
      expiresAt: grant.expiresAt,
    });
    grant.agentWarrantIds.push(warrant.id);
    return warrant;
  }

  /**
   * Withdraws a share. Every warrant it minted falls with it, immediately - a
   * revocation that leaves live authority behind is theatre.
   */
  revoke(grantId: string, reason: string): ShareGrant | null {
    const grant = this.grants.get(grantId);
    if (!grant) return null;
    if (!grant.revokedAt) {
      grant.revokedAt = new Date(this.now()).toISOString();
      grant.revokedReason = reason;
    }
    for (const warrantId of grant.agentWarrantIds) {
      this.registry.revokeById(warrantId, "Share revoked: " + reason);
    }
    return grant;
  }

  get(grantId: string): ShareGrant | null {
    return this.grants.get(grantId) ?? null;
  }

  isLive(grant: ShareGrant): boolean {
    return grant.revokedAt === null && Date.parse(grant.expiresAt) > this.now();
  }

  /** Live grants on one document, for the share dialog's people list. */
  forDoc(docId: string): ShareGrant[] {
    return [...this.grants.values()].filter(
      (grant) => grant.docId === docId && this.isLive(grant),
    );
  }

  /** Live grants handed TO this human. What "Shared with me" reads. */
  forGrantee(humanId: string): ShareGrant[] {
    return [...this.grants.values()].filter(
      (grant) => grant.granteeId === humanId && this.isLive(grant),
    );
  }

  forDocAndGrantee(docId: string, granteeId: string): ShareGrant | null {
    return (
      this.forDoc(docId).find((grant) => grant.granteeId === granteeId) ?? null
    );
  }

  list(): ShareGrant[] {
    return [...this.grants.values()];
  }
}
