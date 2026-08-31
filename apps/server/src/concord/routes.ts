/**
 * CONCORD route surface.
 *
 * ONE identity rule, in two halves.
 *
 *   Humans  never name themselves. Identity comes ONLY from the session token,
 *           exactly like the Track B routes. There is nothing in a body to
 *           forge, because nothing in a body is read.
 *   Agents  are SELECTED with `agentId`, not authenticated by it. The caller
 *           must hold the delegation behind that Agent (`requireAgentOf`), and
 *           the authority to touch the resource is then resolved through the
 *           same WARRANT PDP that guards workspaces - inside the store's
 *           critical section, so a revocation between read and write is
 *           honoured rather than raced.
 *
 * The second half used to be missing, and that was a real hole: Agent ids are
 * not secrets, `/api/warrant/tasks/:id` published them, and every route here
 * would act on any id it was handed.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { ORCHESTRATOR_ID, type WarrantPlane } from "../warrant/index.js";
import { bearerToken, requireAgentOf } from "../warrant/access.js";
import { docResource, keepBoth, type AuthzCheck } from "./store.js";

const docParams = z.object({ docId: z.string().trim().min(1).max(200) });
const agentQuery = z.object({ agentId: z.string().trim().min(1) });
const writeBody = z.object({
  agentId: z.string().trim().min(1),
  expectedVersion: z.number().int().nonnegative(),
  content: z.string().max(1_000_000),
  /**
   * What this write is for, in one line - the same thing an Agent supplies
   * through `CONCORD-COMMIT:` at the end of a turn. Without it a write made
   * over HTTP (a human saving from the editor, say) can only ever be titled
   * "n lines changed" in the Source Control view. store.ts bounds it.
   */
  message: z.string().trim().max(500).optional(),
});
const humanWriteBody = z.object({
  expectedVersion: z.number().int().nonnegative(),
  content: z.string().max(1_000_000),
  message: z.string().trim().max(200).optional(),
});
const leaseBody = z.object({
  agentId: z.string().trim().min(1),
  ttlMs: z.number().int().min(1_000).max(600_000).optional(),
});
const resolveBody = z.object({
  conflictId: z.string().trim().min(1).max(200),
  /**
   * Which side wins, or the text of a hand-merged result. "both" is computed
   * here rather than in the browser so the stored resolution is reproducible
   * from the conflict record alone.
   */
  choice: z.enum(["ours", "theirs", "both", "content"]),
  content: z.string().max(1_000_000).optional(),
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
  plane: WarrantPlane,
): Promise<void> {
  const store = plane.docs;

  const requireHuman = (request: FastifyRequest) => {
    const human = plane.whoami(bearerToken(request));
    if (!human) throw new HttpError(401, "Sign in to continue");
    return human;
  };

  /**
   * Every route below that takes an `agentId` goes through here first. Signing
   * in is not enough: the Agent named has to be one this human delegated to.
   */
  const actingAs = (request: FastifyRequest, agentId: string) => {
    const human = requireHuman(request);
    requireAgentOf(plane, human, agentId);
    return human;
  };

  // Scoped to the caller: an unscoped listing is a directory of every other
  // human's documents, and it hands out the lease holder ids to release.
  app.get("/api/concord/docs", async (request) => {
    const { agentId } = agentQuery.parse(request.query);
    actingAs(request, agentId);
    return { docs: store.list(agentId) };
  });

  app.get("/api/concord/docs/:docId", async (request) => {
    const { docId } = docParams.parse(request.params);
    const { agentId } = agentQuery.parse(request.query);
    actingAs(request, agentId);
    const result = await store.read(docId, agentId);
    if (result.status === "denied") {
      throw new HttpError(403, result.reason ?? "Denied");
    }
    const doc = store.snapshot(docId);
    return {
      ...result,
      resource: docResource(docId),
      conflicts: doc?.conflicts ?? [],
      present: store.presenceOf(docId, agentId),
    };
  });

  app.post("/api/concord/docs/:docId", async (request, reply) => {
    const { docId } = docParams.parse(request.params);
    const body = writeBody.parse(request.body);
    actingAs(request, body.agentId);
    const outcome = await store.write(
      docId,
      body.agentId,
      body.expectedVersion,
      body.content,
      body.message === undefined ? undefined : { message: body.message },
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

  /**
   * A direct human edit - the autosave behind the editor.
   *
   * PUT rather than POST, and no `agentId` anywhere: this is the human writing,
   * not an Agent acting for them. No warrant is consulted, because a warrant is
   * a delegation FROM this human; and no section allocation applies, because
   * allocations bind Agents to their assigned work while the human owns the
   * whole file.
   *
   * 409 when the document moved underneath. A human edit is interactive, so
   * silently merging text somebody is still typing is worse than telling them.
   */
  app.put("/api/concord/docs/:docId", async (request, reply) => {
    const { docId } = docParams.parse(request.params);
    const body = humanWriteBody.parse(request.body);
    const human = requireHuman(request);

    const outcome = await store.writeAsHuman(
      docId,
      human.id,
      body.expectedVersion,
      body.content,
      { ...(body.message ? { message: body.message } : {}) },
    );
    const code =
      outcome.status === "written" ? 200 : outcome.status === "leased" ? 423 : 409;
    return reply.code(code).send({ outcome });
  });

  /** Which Agent owns which section of this document. Drives the editor's bands. */
  app.get("/api/concord/docs/:docId/sections", async (request) => {
    const { docId } = docParams.parse(request.params);
    const { agentId } = agentQuery.parse(request.query);
    actingAs(request, agentId);
    const gate = store.readHistory(docId, agentId);
    if (gate.status === "denied") throw new HttpError(403, gate.reason);
    return { docId, allocations: store.sections.listFor(docId) };
  });

  /**
   * Settling a conflict. The only identity is the session token: a human may
   * settle their own Agent's losing edit, and the orchestrator may settle any.
   */
  app.post("/api/concord/docs/:docId/resolve", async (request, reply) => {
    const { docId } = docParams.parse(request.params);
    const body = resolveBody.parse(request.body);
    const human = requireHuman(request);

    const doc = store.snapshot(docId);
    const pending = doc?.conflicts.find((item) => item.id === body.conflictId);
    if (!pending) throw new HttpError(404, "Conflict not found");

    const chosen =
      body.choice === "ours"
        ? pending.ours
        : body.choice === "theirs"
          ? pending.theirs
          : body.choice === "both"
            ? keepBoth(pending)
            : (body.content ?? "");
    if (body.choice === "content" && !body.content) {
      throw new HttpError(400, "choice 'content' requires the merged text");
    }

    const outcome = await store.resolve(
      docId,
      body.conflictId,
      human.id,
      human.id === ORCHESTRATOR_ID,
      chosen,
    );
    const code =
      outcome.status === "resolved"
        ? 200
        : outcome.status === "denied"
          ? 403
          : outcome.status === "not-found"
            ? 404
            : 409;
    return reply.code(code).send({ outcome });
  });

  /** The conflicts this human is entitled to settle. Drives the review queue. */
  app.get("/api/concord/conflicts", async (request) => {
    const human = requireHuman(request);
    return {
      viewer: human.id,
      conflicts: store.conflictsFor(human.id, human.id === ORCHESTRATOR_ID),
    };
  });

  app.get("/api/concord/docs/:docId/presence", async (request) => {
    const { docId } = docParams.parse(request.params);
    const { agentId } = agentQuery.parse(request.query);
    actingAs(request, agentId);
    const result = store.presenceOf(docId, agentId);
    if (result.status === "denied") throw new HttpError(403, result.reason);
    return result;
  });

  app.post("/api/concord/docs/:docId/lease", async (request, reply) => {
    const { docId } = docParams.parse(request.params);
    const body = leaseBody.parse(request.body);
    actingAs(request, body.agentId);
    const result = await store.acquireLease(
      docId,
      body.agentId,
      body.ttlMs ?? undefined,
    );
    return reply.code(result.ok ? 200 : 423).send(result);
  });

  app.delete("/api/concord/docs/:docId/lease", async (request, reply) => {
    const { docId } = docParams.parse(request.params);
    const { agentId } = agentQuery.parse(request.query);
    actingAs(request, agentId);
    const outcome = await store.releaseLease(docId, agentId);
    if (outcome.status === "denied") {
      throw new HttpError(403, outcome.reason);
    }
    // "Not the holder" is not a denial - the lease simply is not this Agent's
    // to drop - so it stays a 200 that reports what happened.
    return reply.code(200).send({ released: outcome.status === "released", outcome });
  });

  /**
   * Per-line attribution - who last changed each line.
   *
   * Gated on readHistory rather than reading provenanceOf directly: the store's
   * provenance reader is deliberately ungated for internal callers, so the
   * authorization has to be applied here or attribution would leak for
   * documents a warrant does not cover.
   */
  app.get("/api/concord/docs/:docId/blame", async (request) => {
    const { docId } = docParams.parse(request.params);
    const { agentId } = agentQuery.parse(request.query);
    actingAs(request, agentId);
    const gate = store.readHistory(docId, agentId);
    if (gate.status === "denied") throw new HttpError(403, gate.reason);
    if (gate.status === "missing") throw new HttpError(404, "Document not found");

    const doc = gate.doc;
    const provenance = store.provenanceOf(docId);
    const contributions = store.contributionsOf(docId);
    const byId = new Map(contributions.map((entry) => [entry.id, entry]));
    const lines = doc.content.length === 0 ? [] : doc.content.split("\n");

    return {
      id: docId,
      version: doc.version,
      lines: lines.map((text, index) => {
        const entry = provenance[index];
        const contribution = entry?.contributionId
          ? byId.get(entry.contributionId)
          : undefined;
        return {
          lineNumber: index + 1,
          text,
          lineId: entry?.lineId ?? null,
          // null means the line predates any Agent write. It is not "unknown":
          // seeded and human-authored content is attributed to nobody on purpose.
          lastModifiedByAgentId: entry?.lastModifiedByAgentId ?? null,
          contributionId: entry?.contributionId ?? null,
          atVersion: entry?.resultingDocumentVersion ?? null,
          message: contribution?.summary ?? null,
        };
      }),
    };
  });

  /**
   * The Agent-authored commit log. Read through readHistory so the same
   * authorization that guards history guards this - a caller cannot learn who
   * wrote what in a document its warrant does not cover.
   */
  app.get("/api/concord/docs/:docId/contributions", async (request) => {
    const { docId } = docParams.parse(request.params);
    const { agentId } = agentQuery.parse(request.query);
    actingAs(request, agentId);
    const result = store.readHistory(docId, agentId);
    if (result.status === "denied") throw new HttpError(403, result.reason);
    if (result.status === "missing") throw new HttpError(404, "Document not found");
    return {
      id: docId,
      version: result.doc.version,
      contributions: store.contributionsOf(docId),
    };
  });

  app.get("/api/concord/docs/:docId/history", async (request) => {
    const { docId } = docParams.parse(request.params);
    const { agentId } = agentQuery.parse(request.query);
    actingAs(request, agentId);
    const result = store.readHistory(docId, agentId);
    if (result.status === "denied") throw new HttpError(403, result.reason);
    if (result.status === "missing") throw new HttpError(404, "Document not found");
    const doc = result.doc;
    return {
      id: doc.id,
      version: doc.version,
      resource: docResource(doc.id),
      history: doc.history,
      conflicts: doc.conflicts,
    };
  });
}
