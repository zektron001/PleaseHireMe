/**
 * PDP - the authorization decision, as a pure function.
 *
 * Same discipline as the AEGIS policy engine: no I/O, no clock, no registry
 * lookups. Everything the decision needs is resolved by the caller and passed in
 * as `facts`, so every rule - especially every DENY - is a table-driven unit
 * test that runs without a server, a container, or a network.
 *
 * Combining: deny-overrides on a default-deny base. Absence of a warrant is
 * absence of authority.
 */

import type {
  AuthzDecision,
  HumanPrincipal,
  Warrant,
  WarrantAction,
  WarrantAgentPrincipal,
  WarrantScope,
} from "./types.js";
import { covers, isIntegrationBranch, isWorkspace } from "./resources.js";

export interface AuthzFacts {
  readonly now: number;
  /** Human who owns the target resource, when it is an owned resource. */
  readonly resourceOwnerId: string | null;
  /** True when the caller is the orchestrator principal. */
  readonly isOrchestrator: boolean;
  /** For merge.integrate: has every subtask been approved by its owner? */
  readonly allSubtasksApproved: boolean;
  /** Subtask ids still awaiting owner approval, for the denial reason. */
  readonly pendingSubtaskIds: readonly string[];
}

export interface AuthzRequest {
  /** Caller identity, derived from a session token. Never from client input. */
  readonly human: HumanPrincipal | null;
  readonly agent: WarrantAgentPrincipal | null;
  readonly warrant: Warrant | null;
  readonly action: WarrantAction;
  readonly resource: string;
  readonly facts: AuthzFacts;
}

const SCOPE_FOR: Record<WarrantAction, WarrantScope | null> = {
  "workspace.read": "workspace:read",
  "workspace.write": "workspace:write",
  "merge.propose": "merge:propose",
  "merge.integrate": null, // orchestrator-only, governed by WB-7/WB-8
  "task.read": null,
  "comment.write": "comment:write",
};

function decide(
  request: AuthzRequest,
  decision: "Allow" | "Deny",
  ruleId: string,
  reason: string,
): AuthzDecision {
  return {
    humanId: request.human?.id ?? request.agent?.ownerId ?? null,
    agentId: request.agent?.agentId ?? null,
    action: request.action,
    resource: request.resource,
    decision,
    ruleId,
    reason,
    warrantId: request.warrant?.id ?? null,
  };
}

export function authorize(request: AuthzRequest): AuthzDecision {
  const { agent, warrant, action, resource, facts } = request;
  const deny = (ruleId: string, reason: string): AuthzDecision =>
    decide(request, "Deny", ruleId, reason);
  const allow = (ruleId: string, reason: string): AuthzDecision =>
    decide(request, "Allow", ruleId, reason);

  // ---- Orchestrator: integrating the finished work. ----
  if (action === "merge.integrate") {
    if (!facts.isOrchestrator) {
      return deny(
        "WB-7.integrate.orchestrator-only",
        "Only the orchestrator principal may integrate to the shared branch",
      );
    }
    if (!isIntegrationBranch(resource)) {
      return deny(
        "WB-7.integrate.wrong-resource",
        "merge.integrate applies only to the integration branch",
      );
    }
    if (!facts.allSubtasksApproved) {
      return deny(
        "WB-8.integrate.unapproved-subtask",
        "Subtasks awaiting owner approval: " +
          (facts.pendingSubtaskIds.join(", ") || "unknown"),
      );
    }
    return allow(
      "WB-0.integrate.all-approved",
      "Every subtask has been approved by the human who owns it",
    );
  }

  // ---- Everything else is an Agent acting under a warrant. ----
  if (!agent || !warrant) {
    return deny(
      "WB-1.no-warrant",
      "No warrant authorises this Agent; absence of a warrant is absence of authority",
    );
  }
  if (warrant.agentId !== agent.agentId) {
    return deny(
      "WB-1.warrant-agent-mismatch",
      "Warrant was issued to a different Agent",
    );
  }
  if (warrant.revokedAt !== null) {
    return deny(
      "WB-2.warrant-revoked",
      "Warrant was revoked at " +
        warrant.revokedAt +
        (warrant.revokedReason ? ": " + warrant.revokedReason : ""),
    );
  }
  if (Date.parse(warrant.expiresAt) <= facts.now) {
    return deny(
      "WB-3.warrant-expired",
      "Warrant expired at " + warrant.expiresAt,
    );
  }

  const required = SCOPE_FOR[action];
  if (required !== null && !warrant.scopes.includes(required)) {
    return deny(
      "WB-4.scope-not-granted",
      "Warrant does not carry the " + required + " scope",
    );
  }

  // ---- Cross-owner access. Stated as its own rule so the audit record names
  // the actual problem rather than a generic scope failure. ----
  if (
    isWorkspace(resource) &&
    facts.resourceOwnerId !== null &&
    facts.resourceOwnerId !== agent.ownerId
  ) {
    return deny(
      "WB-6.cross-owner-denied",
      "Agent acts for " +
        agent.ownerId +
        " but this workspace belongs to " +
        facts.resourceOwnerId,
    );
  }

  if (!warrant.resources.some((granted) => covers(granted, resource))) {
    return deny(
      "WB-5.resource-outside-warrant",
      "Resource is not in the warrant's granted set",
    );
  }

  return allow(
    "WB-0.warrant-covers-resource",
    "Live warrant " + warrant.id + " grants " + action + " on this resource",
  );
}
