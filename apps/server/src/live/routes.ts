/**
 * The live plane: what the team can see happening, right now.
 *
 * This is the surface the collaboration UI reads. It composes existing state
 * rather than holding any of its own, so there is exactly one place each fact
 * can come from:
 *
 *   sessions     the Orchestrator's tasks and subtasks
 *   people       the Registry's humans, and the Agents their warrants name
 *   access       live warrants - scopes, expiry, revocation
 *   presence     CONCORD's per-document presence records
 *   queue        subtask state + CONCORD conflicts + open review comments
 *   usage        token counts the runner reported, never estimated
 *   activity     the Codex event stream, tapped where AEGIS already taps it
 *
 * Nothing here is a mock. A row appears because something happened; if the
 * Agents are quiet the board is quiet, which is itself the truth.
 *
 * Scope: a human sees their own Agents. The orchestrator sees every one,
 * because reviewing the fan-out is its job - the same rule the decision chain
 * already applies.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { WarrantPlane } from "../warrant/index.js";
import { isOrchestrator, requireHuman } from "../warrant/access.js";
import type { HumanPrincipal, Subtask } from "../warrant/types.js";
import type { ReviewService } from "../review/service.js";
import { activityBus, type ActivityBus, type ActivityEvent } from "./activity.js";

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(300).default(120),
});

const streamQuery = z.object({ token: z.string().trim().min(1).optional() });

/** The role a warrant's scopes actually grant. Derived, never stored. */
function roleOf(scopes: readonly string[]): string {
  if (scopes.includes("workspace:write")) return "Editor";
  if (scopes.includes("merge:propose")) return "Commenter";
  if (scopes.includes("workspace:read")) return "Viewer";
  return "No access";
}

export interface LiveDeps {
  readonly plane: WarrantPlane;
  readonly review: ReviewService | null;
  readonly bus?: ActivityBus;
}

export async function registerLiveRoutes(
  app: FastifyInstance,
  deps: LiveDeps,
): Promise<void> {
  const { plane, review } = deps;
  const bus = deps.bus ?? activityBus;

  /** The Agents this human may watch. `null` means "every one" - orchestrator. */
  const scopeOf = (human: HumanPrincipal): string[] | null => {
    if (isOrchestrator(human)) return null;
    return plane.orchestrator
      .listTasks()
      .flatMap((task) => plane.orchestrator.subtasksOf(task.id))
      .filter((subtask) => subtask.ownerId === human.id)
      .map((subtask) => subtask.agentId);
  };

  const visibleSubtasks = (human: HumanPrincipal): Subtask[] =>
    plane.orchestrator
      .listTasks()
      .flatMap((task) => plane.orchestrator.subtasksOf(task.id))
      .filter((subtask) => isOrchestrator(human) || subtask.ownerId === human.id);

  /**
   * One read for the whole collaboration shell. Cheaper than eight polls, and
   * it means every panel in the UI is looking at the same instant.
   */
  app.get("/api/live/board", async (request) => {
    const human = requireHuman(plane, request);
    const orchestrating = isOrchestrator(human);
    const scope = scopeOf(human);
    const mine = visibleSubtasks(human);

    // Sessions. A "session" in the reel is a shared workspace; here it is a
    // planned Task, which is the thing that actually owns shared paths.
    const sessions = plane.orchestrator
      .listTasks()
      .filter(
        (task) =>
          orchestrating ||
          task.createdBy === human.id ||
          plane.orchestrator.subtasksOf(task.id).some((s) => s.ownerId === human.id),
      )
      .map((task) => {
        const subtasks = plane.orchestrator.subtasksOf(task.id);
        const docs = task.sharedPaths.map((docId) => {
          const doc = plane.docs.snapshot(docId);
          return {
            id: docId,
            version: doc?.version ?? 0,
            conflicts: doc?.conflicts.length ?? 0,
          };
        });
        return {
          id: task.id,
          title: task.title,
          createdBy: task.createdBy,
          createdAt: task.createdAt,
          state: task.state,
          sharedPaths: [...task.sharedPaths],
          running: subtasks.filter((s) => s.state === "in_progress").length,
          docs,
          participants: [...new Set(subtasks.map((s) => s.ownerId))],
          agents: subtasks.map((subtask) => ({
            agentId: subtask.agentId,
            subtaskId: subtask.id,
            title: subtask.title,
            ownerId: subtask.ownerId,
            model: subtask.model,
            state: subtask.state,
            /** Only the caller's own Agents may be directed from the browser. */
            mine: subtask.ownerId === human.id,
          })),
        };
      });

    // People, and the delegation each one holds. The "role" is read off the
    // warrant's scopes - it is a rendering of WARRANT, not a second model.
    const people = plane.registry.listHumans().map((person) => {
      const owned = plane.orchestrator
        .listTasks()
        .flatMap((task) => plane.orchestrator.subtasksOf(task.id))
        .filter((subtask) => subtask.ownerId === person.id);
      return {
        id: person.id,
        handle: person.handle,
        displayName: person.displayName,
        isOrchestrator: isOrchestrator(person),
        agents: owned.map((subtask) => {
          const warrant = plane.registry.warrant(subtask.warrantId);
          return {
            agentId: subtask.agentId,
            subtaskId: subtask.id,
            title: subtask.title,
            state: subtask.state,
            model: subtask.model,
            warrantId: warrant?.id ?? null,
            scopes: warrant ? [...warrant.scopes] : [],
            role: warrant ? roleOf(warrant.scopes) : "No access",
            live: warrant ? plane.registry.isLive(warrant) : false,
            expiresAt: warrant?.expiresAt ?? null,
            revokedAt: warrant?.revokedAt ?? null,
            resources: warrant ? [...warrant.resources] : [],
            /** Revoking is the issuer's call, and only the issuer's. */
            revocableByViewer: warrant?.humanId === human.id,
          };
        }),
      };
    });

    // The queue: work that is pending or in flight. Every row is a real state
    // transition somewhere else in the platform.
    const queue: {
      kind: "turn" | "reiteration" | "conflict" | "comment";
      id: string;
      agentId: string | null;
      humanId: string | null;
      docId: string | null;
      label: string;
      state: string;
    }[] = [];

    for (const subtask of mine) {
      if (subtask.state === "in_progress") {
        queue.push({
          kind: "turn",
          id: subtask.id,
          agentId: subtask.agentId,
          humanId: subtask.ownerId,
          docId: null,
          label: subtask.title,
          state: "running",
        });
      }
    }

    const conflicts = plane.docs.conflictsFor(human.id, orchestrating);
    for (const conflict of conflicts) {
      queue.push({
        kind: "conflict",
        id: conflict.id,
        agentId: conflict.agentId,
        humanId: conflict.humanId,
        docId: conflict.docId,
        label: "Same-line conflict on " + conflict.docId,
        state: "awaiting a human",
      });
    }

    if (review) {
      const watched = new Set(mine.map((subtask) => subtask.agentId));
      for (const comment of review.listAllComments()) {
        if (!orchestrating && !watched.has(comment.responsibleAgentId)) continue;
        if (comment.status === "resolved" || comment.status === "stale") continue;
        queue.push({
          kind: comment.status === "in_progress" ? "reiteration" : "comment",
          id: comment.id,
          agentId: comment.responsibleAgentId,
          humanId: comment.createdByHumanId,
          docId: comment.docId,
          label: comment.body,
          state: comment.status,
        });
      }
    }

    return {
      viewer: human.id,
      scope: orchestrating ? "all" : "own",
      sessions,
      people,
      queue,
      usage: bus.usageFor(scope),
      activity: bus.history(60, scope),
    };
  });

  app.get("/api/live/activity", async (request) => {
    const human = requireHuman(plane, request);
    const { limit } = historyQuery.parse(request.query);
    return { viewer: human.id, events: bus.history(limit, scopeOf(human)) };
  });

  /**
   * The same stream, pushed. SSE rather than WebSockets: this is one-way, it
   * survives a proxy that only speaks HTTP, and it needs no new dependency -
   * which is the whole argument for it at this size.
   *
   * The board endpoint above stays the fallback, so nothing here is required
   * for the UI to be correct - only for it to be immediate.
   */
  app.get("/api/live/stream", async (request: FastifyRequest, reply: FastifyReply) => {
    /**
     * EventSource cannot set an Authorization header, so the stream - and only
     * the stream - also accepts the session token as a query parameter. That is
     * a real trade: a query string reaches access logs where a header does not.
     * It is taken knowingly, for a short-lived demo session token, because the
     * alternative is a WebSocket dependency for one strictly one-way feed. The
     * token is still resolved by the Registry's constant-time lookup, and
     * nothing else on the platform accepts it this way.
     */
    const query = streamQuery.parse(request.query);
    const human =
      plane.whoami(query.token) ?? requireHuman(plane, request);

    /**
     * Re-resolved per event, NOT captured when the stream opens.
     *
     * Found by running it: a browser that connects before splitting a task
     * holds a scope of zero Agents, and every later event is then filtered out
     * for the life of the connection. The stream stayed open, the keep-alives
     * arrived, and not one row was delivered - while the board poll, which
     * resolves the scope on each request, showed all of them.
     */
    const permitted = (event: ActivityEvent): boolean => {
      const scope = scopeOf(human);
      return scope === null || scope.includes(event.agentId);
    };

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Proxies that buffer would defeat the point of streaming at all.
      "X-Accel-Buffering": "no",
    });

    // Node holds the headers until the first body write, so a viewer with no
    // Agents yet would see nothing at all - not even a connection. Flushing
    // here is what makes EventSource's `onopen` fire promptly, and it is why
    // the UI can honestly say "live" rather than "probably live".
    reply.raw.flushHeaders();
    reply.raw.write(": connected\n\n");

    const send = (event: ActivityEvent): void => {
      if (!permitted(event)) return;
      reply.raw.write("data: " + JSON.stringify(event) + "\n\n");
    };

    for (const event of bus.history(30, scopeOf(human)).reverse()) send(event);

    const unsubscribe = bus.subscribe(send);
    // Comment frames, not data frames: they keep the connection open through
    // an idle proxy without appearing on the board as activity that happened.
    const keepAlive = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15_000);
    const close = (): void => {
      clearInterval(keepAlive);
      unsubscribe();
    };
    request.raw.on("close", close);
    request.raw.on("error", close);

    // Never resolves: Fastify must not end the response while the stream lives.
    return reply;
  });

  app.get("/api/live/access", async (request) => {
    const human = requireHuman(plane, request);
    const warrants = plane.registry.listWarrants().filter(
      (warrant) => isOrchestrator(human) || warrant.humanId === human.id,
    );
    if (warrants.length === 0 && !isOrchestrator(human)) {
      // Not an error: a human who has delegated nothing has an empty sheet.
      return { viewer: human.id, warrants: [] };
    }
    return {
      viewer: human.id,
      warrants: warrants.map((warrant) => ({
        id: warrant.id,
        humanId: warrant.humanId,
        agentId: warrant.agentId,
        subtaskId: warrant.subtaskId,
        role: roleOf(warrant.scopes),
        scopes: [...warrant.scopes],
        resources: [...warrant.resources],
        issuedAt: warrant.issuedAt,
        expiresAt: warrant.expiresAt,
        revokedAt: warrant.revokedAt,
        revokedReason: warrant.revokedReason,
        live: plane.registry.isLive(warrant),
        revocableByViewer: warrant.humanId === human.id,
      })),
    };
  });

  app.log.info("Live collaboration routes registered");
}
