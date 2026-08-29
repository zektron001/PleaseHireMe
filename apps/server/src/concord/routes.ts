/**
 * CONCORD route surface.
 *
 * Every operation names the Agent, and authority is resolved through the same
 * WARRANT PDP that guards workspaces - inside the store's critical section, so a
 * revocation between read and write is honoured rather than raced.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors.js";
import type { WarrantPlane } from "../warrant/index.js";
import { docResource, SharedDocStore, type AuthzCheck } from "./store.js";

const docParams = z.object({ docId: z.string().trim().min(1).max(200) });
const agentQuery = z.object({ agentId: z.string().trim().min(1) });
const writeBody = z.object({
  agentId: z.string().trim().min(1),
  expectedVersion: z.number().int().nonnegative(),
  content: z.string().max(1_000_000),
});
const leaseBody = z.object({
  agentId: z.string().trim().min(1),
  ttlMs: z.number().int().min(1_000).max(600_000).optional(),
});

/**
 * Bridges CONCORD to WARRANT. A document is just another resource the warrant
 * either covers or does not, so no second authorization model is introduced.
 */
export function warrantAuthzCheck(plane: WarrantPlane): AuthzCheck {
  return (agentId, action, resource) => {
    const decision = plane.check({ agentId, action, resource });
    return {
      allowed: decision.decision === "Allow",
      ruleId: decision.ruleId,
      reason: decision.reason,
      humanId: decision.humanId,
    };
  };
}

export async function registerConcordRoutes(
  app: FastifyInstance,
  store: SharedDocStore,
): Promise<void> {
  app.get("/api/concord/docs", async () => ({ docs: store.list() }));

  app.get("/api/concord/docs/:docId", async (request) => {
    const { docId } = docParams.parse(request.params);
    const { agentId } = agentQuery.parse(request.query);
    const result = await store.read(docId, agentId);
    if (result.status === "denied") {
      throw new HttpError(403, result.reason ?? "Denied");
    }
    return result;
  });

  app.post("/api/concord/docs/:docId", async (request, reply) => {
    const { docId } = docParams.parse(request.params);
    const body = writeBody.parse(request.body);
    const outcome = await store.write(
      docId,
      body.agentId,
      body.expectedVersion,
      body.content,
    );

    // Each outcome gets the status code that describes it, so a client can tell
    // "you may not" from "someone else got there first" from "rebase and retry".
    const code =
      outcome.status === "written" || outcome.status === "merged"
        ? 200
        : outcome.status === "denied"
          ? 403
          : outcome.status === "leased"
            ? 423 // Locked
            : 409; // Conflict
    return reply.code(code).send({ outcome });
  });

  app.post("/api/concord/docs/:docId/lease", async (request, reply) => {
    const { docId } = docParams.parse(request.params);
    const body = leaseBody.parse(request.body);
    const result = await store.acquireLease(
      docId,
      body.agentId,
      body.ttlMs ?? undefined,
    );
    return reply.code(result.ok ? 200 : 423).send(result);
  });

  app.delete("/api/concord/docs/:docId/lease", async (request) => {
    const { docId } = docParams.parse(request.params);
    const { agentId } = agentQuery.parse(request.query);
    return { released: await store.releaseLease(docId, agentId) };
  });

  app.get("/api/concord/docs/:docId/history", async (request) => {
    const { docId } = docParams.parse(request.params);
    const doc = store.snapshot(docId);
    if (!doc) throw new HttpError(404, "Document not found");
    return {
      id: doc.id,
      version: doc.version,
      resource: docResource(doc.id),
      history: doc.history,
    };
  });
}
