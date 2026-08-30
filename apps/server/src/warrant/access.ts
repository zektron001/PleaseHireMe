/**
 * Who is calling, and which Agent may they speak through.
 *
 * The hole this closes: CONCORD and the review routes take an `agentId` in a
 * query string or body, and until now that was the ONLY identity they read. An
 * Agent id is not a secret - `/api/warrant/tasks/:id` handed them out to
 * anonymous callers - so anyone who had seen one could read and write another
 * human's shared documents, with `APP_AUTH_TOKEN` set or not.
 *
 * The rule now is the one WARRANT already applies everywhere else:
 *
 *   the HUMAN comes from the session token and nowhere else;
 *   the AGENT id names which of that human's delegations to act through.
 *
 * So `agentId` stops being a credential and becomes a selector. Forging one
 * gets you a 403, because the warrant behind it belongs to somebody whose
 * session you do not hold. The PDP check that follows is unchanged - this is a
 * gate in front of it, not a replacement for it.
 */

import type { FastifyRequest } from "fastify";
import { HttpError } from "../errors.js";
// Imported from the orchestrator rather than the facade: the facade pulls in
// CONCORD, which imports this module back.
import { ORCHESTRATOR_ID } from "./orchestrator.js";
import type { WarrantPlane } from "./index.js";
import type { HumanPrincipal, Subtask } from "./types.js";

/** The ONLY identity source. Same rule as warrant/routes.ts. */
export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : undefined;
}

export function requireHuman(
  plane: WarrantPlane,
  request: FastifyRequest,
): HumanPrincipal {
  const human = plane.whoami(bearerToken(request));
  if (!human) throw new HttpError(401, "Sign in to continue");
  return human;
}

export function isOrchestrator(human: HumanPrincipal): boolean {
  return human.id === ORCHESTRATOR_ID;
}

/**
 * Confirms this human may act through this Agent, and audits the answer.
 *
 * The orchestrator is allowed through because reviewing the whole fan-out is
 * its job; it still holds no workspace authority of its own, so every write it
 * names is decided by the PDP exactly as before (WB-7/WB-8).
 */
export function requireAgentOf(
  plane: WarrantPlane,
  human: HumanPrincipal,
  agentId: string,
): Subtask | null {
  const subtask = plane.orchestrator.subtaskByAgent(agentId);
  const allowed = isOrchestrator(human) || subtask?.ownerId === human.id;

  plane.record({
    humanId: human.id,
    agentId,
    action: "workspace.read",
    resource: subtask ? "ws:" + subtask.id : "agent:" + agentId,
    decision: allowed ? "Allow" : "Deny",
    ruleId: allowed ? "WB-0.acts-through-own-agent" : "WB-11.agent-not-delegated",
    reason: allowed
      ? "The caller holds the delegation behind this Agent"
      : subtask
        ? "That Agent acts for " + subtask.ownerId + ", not for you"
        : "No delegation names that Agent",
    warrantId: subtask?.warrantId ?? null,
  });

  if (!allowed) {
    throw new HttpError(403, "That Agent does not act for you");
  }
  return subtask;
}
