/**
 * PIP - humans, warrants and sessions.
 *
 * The one rule that makes the Track B success test pass:
 *
 *   "changing a user ID in the browser request cannot bypass the authorization
 *    decision"
 *
 * is satisfied structurally, not by validation. A caller's identity is derived
 * ONLY from an opaque session token via `resolveSession`. No route, service, or
 * policy rule anywhere in this codebase reads a human id out of a request body,
 * query string, or header. There is nothing to forge, because nothing is read.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type {
  HumanPrincipal,
  Session,
  Warrant,
  WarrantAgentPrincipal,
  WarrantOrigin,
  WarrantScope,
} from "./types.js";

export interface IssueWarrantInput {
  readonly humanId: string;
  readonly agentId: string;
  readonly subtaskId: string;
  readonly scopes: readonly WarrantScope[];
  readonly resources: readonly string[];
  readonly ttlMs?: number;
  /** Defaults to "subtask" so the orchestrator's call site is unchanged. */
  readonly origin?: WarrantOrigin;
  readonly grantedBy?: string;
  /** Absolute expiry, when it must match a grant's rather than a TTL. */
  readonly expiresAt?: string;
}

export const DEFAULT_WARRANT_TTL_MS = 3_600_000;

export class Registry {
  private readonly humans = new Map<string, HumanPrincipal>();
  private readonly byHandle = new Map<string, string>();
  private readonly warrants = new Map<string, Warrant>();
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly now: () => number = Date.now) {}

  // ------------------------------------------------------------- humans
  addHuman(handle: string, displayName: string): HumanPrincipal {
    const existingId = this.byHandle.get(handle.toLowerCase());
    const existing = existingId ? this.humans.get(existingId) : undefined;
    if (existing) return existing;

    const human: HumanPrincipal = {
      id: "human:" + handle.toLowerCase(),
      handle: handle.toLowerCase(),
      displayName,
    };
    this.humans.set(human.id, human);
    this.byHandle.set(human.handle, human.id);
    return human;
  }

  human(id: string): HumanPrincipal | null {
    return this.humans.get(id) ?? null;
  }

  humanByHandle(handle: string): HumanPrincipal | null {
    const id = this.byHandle.get(handle.trim().toLowerCase());
    return id ? (this.humans.get(id) ?? null) : null;
  }

  listHumans(): HumanPrincipal[] {
    return [...this.humans.values()];
  }

  // ----------------------------------------------------------- sessions
  openSession(humanId: string): Session {
    const session: Session = {
      token: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      humanId,
      issuedAt: new Date(this.now()).toISOString(),
    };
    this.sessions.set(session.token, session);
    return session;
  }

  /**
   * The ONLY way to learn who is calling. Constant-time compare so a token
   * cannot be discovered by timing the lookup.
   */
  resolveSession(token: string | undefined): HumanPrincipal | null {
    if (!token) return null;
    const candidate = Buffer.from(token);
    for (const [stored, session] of this.sessions) {
      const storedBuffer = Buffer.from(stored);
      if (
        storedBuffer.length === candidate.length &&
        timingSafeEqual(storedBuffer, candidate)
      ) {
        return this.humans.get(session.humanId) ?? null;
      }
    }
    return null;
  }

  closeSession(token: string): void {
    this.sessions.delete(token);
  }

  // ----------------------------------------------------------- warrants
  issue(input: IssueWarrantInput): Warrant {
    const issuedAt = this.now();
    const warrant: Warrant = {
      id: "wrt_" + randomUUID(),
      humanId: input.humanId,
      agentId: input.agentId,
      subtaskId: input.subtaskId,
      origin: input.origin ?? "subtask",
      grantedBy: input.grantedBy ?? null,
      scopes: [...input.scopes],
      resources: [...input.resources],
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt:
        input.expiresAt ??
        new Date(issuedAt + (input.ttlMs ?? DEFAULT_WARRANT_TTL_MS)).toISOString(),
      revokedAt: null,
      revokedReason: null,
    };
    this.warrants.set(warrant.id, warrant);
    return warrant;
  }

  warrant(id: string | null): Warrant | null {
    return id ? (this.warrants.get(id) ?? null) : null;
  }

  /** The live warrant for an Agent, if it has one. */
  warrantForAgent(agentId: string): Warrant | null {
    for (const warrant of this.warrants.values()) {
      if (warrant.agentId === agentId && this.isLive(warrant)) return warrant;
    }
    return null;
  }

  listWarrants(): Warrant[] {
    return [...this.warrants.values()];
  }

  /** Every live warrant this human has delegated. The basis of attenuation. */
  liveWarrantsForHuman(humanId: string): Warrant[] {
    return [...this.warrants.values()].filter(
      (warrant) => warrant.humanId === humanId && this.isLive(warrant),
    );
  }

  /**
   * Revocation driven by a grant rather than by a human, used when a share is
   * withdrawn and every warrant minted from it has to fall with it.
   *
   * Deliberately NOT an ownership check: the caller has already proved it may
   * revoke the grant, and the warrants below were minted by that grant rather
   * than by the human who now holds them.
   */
  revokeById(id: string, reason: string): boolean {
    const warrant = this.warrants.get(id);
    if (!warrant) return false;
    if (warrant.revokedAt) return true;
    warrant.revokedAt = new Date(this.now()).toISOString();
    warrant.revokedReason = reason;
    return true;
  }

  /**
   * Revocation is immediate and irreversible. Returns false when the warrant is
   * unknown, or when `byHumanId` is not the human who issued it - a human may
   * only revoke their own delegations.
   */
  revoke(id: string, byHumanId: string, reason: string): boolean {
    const warrant = this.warrants.get(id);
    if (!warrant || warrant.humanId !== byHumanId) return false;
    if (warrant.revokedAt) return true;
    warrant.revokedAt = new Date(this.now()).toISOString();
    warrant.revokedReason = reason;
    return true;
  }

  isExpired(warrant: Warrant): boolean {
    return Date.parse(warrant.expiresAt) <= this.now();
  }

  isLive(warrant: Warrant): boolean {
    return warrant.revokedAt === null && !this.isExpired(warrant);
  }

  /** Derives the Agent principal a warrant authorises. */
  principalFor(warrant: Warrant): WarrantAgentPrincipal {
    return {
      kind: "agent",
      agentId: warrant.agentId,
      ownerId: warrant.humanId,
      warrantId: warrant.id,
      scopes: warrant.scopes,
    };
  }
}
