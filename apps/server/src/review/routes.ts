/**
 * Review route surface.
 *
 * Identity follows the CONCORD rule exactly: a human never names itself. The
 * reviewer is read from the session token, so a comment cannot be attributed to
 * someone else by editing a request body.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors.js";
import type { AgentRunner } from "../types.js";
import type { WarrantPlane } from "../warrant/index.js";
import { runReiteration } from "./reiteration.js";
import { ReviewService } from "./service.js";

const docParams = z.object({ docId: z.string().trim().min(1).max(200) });
const commentParams = z.object({ commentId: z.string().uuid() });
const agentQuery = z.object({ agentId: z.string().trim().min(1) });
const rangeQuery = z.object({
  agentId: z.string().trim().min(1),
  startLine: z.coerce.number().int().min(1),
  endLine: z.coerce.number().int().min(1),
});
const createCommentBody = z.object({
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  body: z.string().trim().min(1).max(2_000),
  targetAgentId: z.string().trim().min(1).optional(),
});
const reiterateBody = z.object({
  commentIds: z.array(z.string().uuid()).min(1).max(50),
});

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

export async function registerReviewRoutes(
  app: FastifyInstance,
  plane: WarrantPlane,
  runner: AgentRunner | null,
  review: ReviewService = new ReviewService(plane.docs),
): Promise<ReviewService> {
  const requireHuman = (request: FastifyRequest) => {
    const human = plane.whoami(bearerToken(request));
    if (!human) throw new HttpError(401, "Sign in to continue");
    return human;
  };

  /** Who should receive a comment on this range, from CONCORD provenance. */
  app.get("/api/review/docs/:docId/route", async (request) => {
    requireHuman(request);
    const { docId } = docParams.parse(request.params);
    const { agentId, startLine, endLine } = rangeQuery.parse(request.query);
    if (endLine < startLine) throw new HttpError(400, "endLine precedes startLine");
    return review.routeFor(docId, agentId, startLine, endLine);
  });

  app.get("/api/review/docs/:docId/comments", async (request) => {
    requireHuman(request);
    const { docId } = docParams.parse(request.params);
    const { agentId } = agentQuery.parse(request.query);
    // Gate on the same authorization that guards document history.
    const gate = plane.docs.readHistory(docId, agentId);
    if (gate.status === "denied") throw new HttpError(403, gate.reason);
    return {
      comments: review.listComments(docId),
      runs: review.listRuns(docId),
      events: review.listEvents(docId),
    };
  });

  app.post("/api/review/docs/:docId/comments", async (request, reply) => {
    const human = requireHuman(request);
    const { docId } = docParams.parse(request.params);
    const body = createCommentBody.parse(request.body);
    const comment = review.createComment({
      docId,
      startLine: body.startLine,
      endLine: body.endLine,
      body: body.body,
      humanId: human.id,
      targetAgentId: body.targetAgentId,
    });
    return reply.code(201).send({ comment });
  });

  app.post("/api/review/comments/:commentId/resolve", async (request) => {
    const human = requireHuman(request);
    const { commentId } = commentParams.parse(request.params);
    const comment = review.get(commentId);
    if (comment.createdByHumanId !== human.id) {
      throw new HttpError(403, "That comment belongs to another reviewer");
    }
    return { comment: review.resolve(commentId, human.id) };
  });

  /**
   * Comments aimed at different Agents become separate runs, launched together
   * so those Agents proceed in parallel.
   */
  app.post("/api/review/reiterations", async (request, reply) => {
    const human = requireHuman(request);
    const { commentIds } = reiterateBody.parse(request.body);
    const groups = review.planRuns(commentIds, human.id);

    const runs = await Promise.all(
      groups.map((group) =>
        runReiteration(
          { plane, docs: plane.docs, reconciler: plane.reconciler, review, runner },
          group.docId,
          group.agentId,
          human.id,
          group.comments,
        ).catch((error: unknown) => ({
          error: error instanceof HttpError ? error.message : "Re-iteration failed",
          docId: group.docId,
          agentId: group.agentId,
        })),
      ),
    );
    return reply.code(202).send({ runs });
  });

  return review;
}
