/**
 * Track B route surface.
 *
 * THE SUCCESS TEST: "changing a user ID in the browser request cannot bypass the
 * authorization decision."
 *
 * It holds structurally. Not one handler below reads an identity from the
 * request body, query string, or headers - the only identity source is
 * `bearerToken(request)` -> `plane.whoami(token)`. A forged `X-Acting-User` or
 * `?humanId=` is not rejected; it is simply never consulted. There is nothing to
 * forge because nothing is read.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AgentRunner } from "../types.js";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { ORCHESTRATOR_ID, type WarrantPlane } from "./index.js";
import type { HumanPrincipal } from "./types.js";
import { workspaceResource } from "./resources.js";
import { docResource } from "../concord/store.js";
import { canShare, heldScopes, maxShareableRole } from "./sharing.js";
import { SCOPES_FOR_ROLE, type ShareGrant } from "./types.js";
import {
  parseCheckpoint,
  withCheckpointInstruction,
} from "../concord/checkpoint.js";
import { WarrantBindingError } from "./binding.js";
import { activityBus } from "../live/activity.js";

const loginBody = z.object({ handle: z.string().trim().min(1).max(40) });

const planBody = z.object({
  title: z.string().trim().min(1).max(200),
  owners: z.array(z.string().trim().min(1)).min(1).max(8),
  maxSubtasks: z.number().int().min(1).max(6).optional(),
  warrantTtlMs: z.number().int().min(1000).max(86_400_000).optional(),
  /** Files every subtask may write. These need CONCORD, not static ownership. */
  sharedPaths: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
});

const actBody = z.object({
  agentId: z.string().trim().min(1),
  action: z.enum(["workspace.read", "workspace.write", "merge.propose"]),
  resource: z.string().trim().min(1).max(300),
});

const subtaskParams = z.object({ subtaskId: z.string().trim().min(1) });
const taskParams = z.object({ taskId: z.string().trim().min(1) });
const runBody = z.object({
  prompt: z.string().trim().min(1).max(10_000),
});

const revokeBody = z.object({
  warrantId: z.string().trim().min(1),
  reason: z.string().trim().max(200).default("Revoked by owner"),
});

const docParams = z.object({ docId: z.string().trim().min(1).max(300) });
const grantParams = z.object({ grantId: z.string().trim().min(1) });

/**
 * Note what is NOT in here: a granter id. The sharer is the session holder and
 * nothing else, so the Track B success test - "changing a user ID in the
 * browser request cannot bypass the authorization decision" - covers sharing
 * for the same structural reason it covers everything else.
 */
const shareBody = z.object({
  granteeId: z.string().trim().min(1).max(80),
  role: z.enum(["viewer", "commenter", "editor"]),
  ttlMs: z.number().int().min(60_000).max(2_592_000_000).optional(),
});

const attachBody = z.object({ agentId: z.string().trim().min(1).max(120) });
const unshareBody = z.object({
  reason: z.string().trim().max(200).default("Access removed by the sharer"),
});

/** The ONLY identity source in this module. */
function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : undefined;
}

export async function registerWarrantRoutes(
  app: FastifyInstance,
  plane: WarrantPlane,
  /** Absent in unit tests that never execute a turn. */
  runner?: AgentRunner,
): Promise<void> {
  const requireHuman = (request: FastifyRequest) => {
    const human = plane.whoami(bearerToken(request));
    if (!human) throw new HttpError(401, "Sign in to continue");
    return human;
  };

  // ------------------------------------------------------------- session
  app.get("/api/warrant/humans", async () => ({
    humans: plane.registry.listHumans(),
  }));

  app.post("/api/warrant/session", async (request, reply) => {
    const { handle } = loginBody.parse(request.body);
    const human = plane.registry.humanByHandle(handle);
    if (!human) throw new HttpError(404, "Unknown user");
    const session = plane.registry.openSession(human.id);
    return reply.code(201).send({ token: session.token, human });
  });

  app.get("/api/warrant/me", async (request) => ({ human: requireHuman(request) }));

  // --------------------------------------------------------------- plan
  app.post("/api/warrant/tasks", async (request, reply) => {
    const human = requireHuman(request);
    const body = planBody.parse(request.body);

    for (const owner of body.owners) {
      if (!plane.registry.human(owner)) {
        throw new HttpError(400, "Unknown owner: " + owner);
      }
    }
    const result = await plane.orchestrator.plan({
      title: body.title,
      createdBy: human.id,
      owners: body.owners,
      ...(body.maxSubtasks === undefined ? {} : { maxSubtasks: body.maxSubtasks }),
      ...(body.warrantTtlMs === undefined ? {} : { warrantTtlMs: body.warrantTtlMs }),
      ...(body.sharedPaths === undefined ? {} : { sharedPaths: body.sharedPaths }),
    });
    return reply.code(201).send(result);
  });

  /**
   * Scoped, and that matters more than it looks. A task carries the Agent ids
   * of every subtask, and CONCORD selects an Agent by id. Serving this
   * anonymously - which it used to - published the selector for every shared
   * document on the platform. It is now a participant-only view, and the id it
   * hands you is useless without the session of the human who delegated it.
   */
  const participates = (human: HumanPrincipal, taskId: string): boolean =>
    human.id === ORCHESTRATOR_ID ||
    plane.orchestrator.task(taskId)?.createdBy === human.id ||
    plane.orchestrator.subtasksOf(taskId).some((s) => s.ownerId === human.id);

  app.get("/api/warrant/tasks", async (request) => {
    const human = requireHuman(request);
    return {
      viewer: human.id,
      tasks: plane.orchestrator
        .listTasks()
        .filter((task) => participates(human, task.id)),
    };
  });

  app.get("/api/warrant/tasks/:taskId", async (request) => {
    const human = requireHuman(request);
    const { taskId } = taskParams.parse(request.params);
    const task = plane.orchestrator.task(taskId);
    // Same 404 either way: "you may not see it" and "it does not exist" must
    // not be distinguishable, or this becomes a task-id oracle.
    if (!task || !participates(human, taskId)) {
      throw new HttpError(404, "Task not found");
    }
    // Collaborators ARE visible to each other - that is the product - but see
    // the note above: the ids are selectors, not credentials.
    return { task, subtasks: plane.orchestrator.subtasksOf(taskId) };
  });

  // ------------------------------------------------------- agent actions
  /**
   * An Agent attempting an action. The decision is made by the PDP and audited
   * whether it succeeds or fails - a denial is evidence, not an error to hide.
   */
  app.post("/api/warrant/act", async (request, reply) => {
    const body = actBody.parse(request.body);
    const decision = plane.check({
      agentId: body.agentId,
      action: body.action,
      resource: body.resource,
    });
    return reply.code(decision.decision === "Allow" ? 200 : 403).send({ decision });
  });

  app.post("/api/warrant/subtasks/:subtaskId/submit", async (request) => {
    const { subtaskId } = subtaskParams.parse(request.params);
    const subtask = plane.orchestrator.subtask(subtaskId);
    if (!subtask) throw new HttpError(404, "Subtask not found");

    const decision = plane.check({
      agentId: subtask.agentId,
      action: "merge.propose",
      resource: workspaceResource(subtaskId),
    });
    if (decision.decision === "Deny") {
      throw new HttpError(403, decision.reason);
    }
    return { subtask: plane.orchestrator.setState(subtaskId, "submitted"), decision };
  });

  /**
   * Execute one turn for a subtask Agent, with CONCORD around it.
   *
   * This is where the three planes meet on one request:
   *
   *   WARRANT  binds the Agent to exactly one workspace, or refuses to produce a
   *            runner request at all - an Agent with no live warrant gets no
   *            container, not a container it is then denied inside.
   *   CONCORD  materializes the shared documents at their committed version
   *            before the turn, and submits whatever changed back through the
   *            store afterwards. The Agent never writes shared state directly.
   *   AEGIS    is already inside `runner`, which is the guarded runner when the
   *            middleware is enabled.
   */
  app.post("/api/warrant/subtasks/:subtaskId/run", async (request, reply) => {
    const human = requireHuman(request);
    const { subtaskId } = subtaskParams.parse(request.params);
    const body = runBody.parse(request.body);

    const subtask = plane.orchestrator.subtask(subtaskId);
    if (!subtask) throw new HttpError(404, "Subtask not found");

    // Spending an Agent's authority is the owner's call. Identity is the session
    // token, so this cannot be bypassed by naming a different human.
    const owned = subtask.ownerId === human.id;
    plane.record({
      humanId: human.id,
      agentId: subtask.agentId,
      action: "workspace.write",
      resource: workspaceResource(subtaskId),
      decision: owned ? "Allow" : "Deny",
      ruleId: owned ? "WB-0.owner-runs-agent" : "WB-6.cross-owner",
      reason: owned
        ? "The accountable human started their own Agent"
        : "Only " + subtask.ownerId + " may run this Agent",
      warrantId: subtask.warrantId,
    });
    if (!owned) throw new HttpError(403, "Only " + subtask.ownerId + " may run this Agent");
    if (!runner) throw new HttpError(503, "No Agent runtime is configured");

    let bound;
    try {
      bound = plane.binder.bind(
        subtask.agentId,
        withCheckpointInstruction(body.prompt),
      );
    } catch (error) {
      if (error instanceof WarrantBindingError) {
        plane.record(error.decision);
        throw new HttpError(403, error.message);
      }
      throw error;
    }

    // The same guard consultation and re-iteration apply. Two concurrent turns
    // for one Agent materialize into the same workspace and reconcile against
    // the same stale checkout, so the second silently overwrites the first.
    if (subtask.state === "in_progress") {
      throw new HttpError(409, "That Agent is already running");
    }

    const shared = plane.orchestrator.task(subtask.taskId)?.sharedPaths ?? [];
    const workspacePath = bound.request.workspacePath;

    const materialized = await plane.reconciler.materialize(
      workspacePath,
      subtask.agentId,
      shared,
    );

    plane.orchestrator.setState(subtaskId, "in_progress");
    /**
     * The live board taps the same Codex event stream AEGIS already inspects.
     * `body.prompt` is the human's own words, not the compiled prompt, and it
     * is truncated on the way in - so "what is Alice asking her Agent" is
     * answerable without publishing anything the Agent was actually sent.
     */
    const watch = activityBus.watch({
      agentId: subtask.agentId,
      subtaskId,
      humanId: human.id,
      purpose: "turn",
      prompt: body.prompt,
      model: bound.model,
    });
    try {
      const result = await runner.run({ ...bound.request, inspect: watch.inspect });
      watch.finish(result.usage);
      const checkpoint = parseCheckpoint(result.output);
      const reconciled = await plane.reconciler.reconcile(
        workspacePath,
        subtask.agentId,
        shared,
        { message: checkpoint, runId: subtaskId },
      );
      // The turn is over, so the Agent is idle again. Without this the subtask
      // stays "in_progress" for the life of the process: the failure path reset
      // it and the success path never did. That was harmless while nothing read
      // the state, and stopped being harmless once consultation and
      // re-iteration began refusing an Agent that is already running.
      // "submitted" is a separate step the owner takes; finishing a turn is not
      // submitting it.
      plane.orchestrator.setState(subtaskId, "assigned");
      return reply.code(200).send({
        subtaskId,
        agentId: subtask.agentId,
        model: bound.model,
        output: result.output,
        usage: result.usage,
        materialized,
        reconciled,
        checkpoint,
      });
    } catch (error) {
      plane.orchestrator.setState(subtaskId, "assigned");
      watch.fail(error instanceof Error ? error.message : String(error));
      // A failed turn may still have left edits on disk. Reconciling anyway is
      // the safe direction: the alternative is silently dropping work that the
      // Agent did before it fell over.
      const reconciled = await plane.reconciler.reconcile(
        workspacePath,
        subtask.agentId,
        shared,
        { message: null, runId: subtaskId },
      );
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({ subtaskId, error: message, materialized, reconciled });
    }
  });

  // -------------------------------------------------- owner approval
  app.post("/api/warrant/subtasks/:subtaskId/approve", async (request) => {
    const human = requireHuman(request);
    const { subtaskId } = subtaskParams.parse(request.params);
    const result = plane.orchestrator.approve(subtaskId, human.id);

    plane.record({
      humanId: human.id,
      agentId: null,
      action: "merge.propose",
      resource: workspaceResource(subtaskId),
      decision: result.ok ? "Allow" : "Deny",
      ruleId: result.ok ? "WB-0.owner-approves" : "WB-9.approval-not-owner",
      reason: result.reason,
      warrantId: null,
    });

    if (!result.ok) throw new HttpError(403, result.reason);
    return { subtask: plane.orchestrator.subtask(subtaskId), reason: result.reason };
  });

  // -------------------------------------------------------- integration
  app.post("/api/warrant/tasks/:taskId/integrate", async (request, reply) => {
    requireHuman(request);
    const { taskId } = taskParams.parse(request.params);
    if (!plane.orchestrator.task(taskId)) throw new HttpError(404, "Task not found");

    const decision = plane.check({
      token: bearerToken(request),
      action: "merge.integrate",
      resource: plane.orchestrator.integrationBranch,
      taskId,
    });
    if (decision.decision === "Deny") {
      return reply.code(403).send({ decision });
    }
    return { task: plane.orchestrator.markIntegrated(taskId), decision };
  });

  // --------------------------------------------------------- revocation
  app.post("/api/warrant/revoke", async (request) => {
    const human = requireHuman(request);
    const body = revokeBody.parse(request.body);
    const ok = plane.registry.revoke(body.warrantId, human.id, body.reason);

    plane.record({
      humanId: human.id,
      agentId: plane.registry.warrant(body.warrantId)?.agentId ?? null,
      action: "warrant.revoke",
      resource: "warrant:" + body.warrantId,
      decision: ok ? "Allow" : "Deny",
      ruleId: ok ? "WB-0.revoke-own-warrant" : "WB-10.revoke-not-issuer",
      reason: ok
        ? body.reason
        : "Only the human who issued a warrant may revoke it",
      warrantId: body.warrantId,
    });

    if (!ok) {
      throw new HttpError(403, "Only the human who issued a warrant may revoke it");
    }
    return { warrant: plane.registry.warrant(body.warrantId) };
  });

  // ---------------------------------------------------------- evidence
  /** The platform's whole delegation graph. Signed-in readers only. */
  app.get("/api/warrant/status", async (request) => {
    requireHuman(request);
    return plane.status();
  });

  /**
   * T7 - trace access control, plus T5 scoped queries.
   *
   * The decision log names who asked for what, so it is itself sensitive: an
   * unauthenticated reader learns every human, Agent, resource and denial on the
   * platform. A session is now required, and an ordinary human sees only
   * decisions they are a party to. The orchestrator sees everything, because
   * reviewing the fan-out is its job.
   */
  app.get("/api/warrant/events", async (request) => {
    const human = requireHuman(request);
    const isOrchestrator = human.id === ORCHESTRATOR_ID;

    const ownAgents = new Set(
      plane.orchestrator
        .listTasks()
        .flatMap((task) => plane.orchestrator.subtasksOf(task.id))
        .filter((subtask) => subtask.ownerId === human.id)
        .map((subtask) => subtask.agentId),
    );

    const visible = plane.audit
      .recent(500)
      .filter(
        (event) =>
          isOrchestrator ||
          event.evidence["human"] === human.id ||
          ownAgents.has(String(event.evidence["agent"])),
      );

    return {
      viewer: human.id,
      scope: isOrchestrator ? "all" : "own",
      captureLevel: plane.audit.level,
      retained: plane.audit.retained,
      pruned: plane.audit.pruned,
      chainHead: plane.audit.chainHead,
      chainAnchor: plane.audit.chainAnchor,
      // Verified over the full retained chain, not the filtered view: a scoped
      // slice is not contiguous, so verifying it would be meaningless.
      chainValid: plane.audit.verify() === -1,
      events: visible.slice(-200),
    };
  });

  /* ------------------------------------------------------------- sharing */

  /**
   * Decorates a grant with the display data the share dialog needs, so the
   * browser never has to join two lists to render one row.
   */
  const describe = (grant: ShareGrant) => ({
    id: grant.id,
    docId: grant.docId,
    role: grant.role,
    grantedBy: grant.grantedBy,
    grantedByName: plane.registry.human(grant.grantedBy)?.displayName ?? grant.grantedBy,
    granteeId: grant.granteeId,
    granteeName: plane.registry.human(grant.granteeId)?.displayName ?? grant.granteeId,
    scopes: SCOPES_FOR_ROLE[grant.role],
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    /** The Agents the grantee has attached. Empty until they bring one. */
    agents: grant.agentWarrantIds
      .map((id) => plane.registry.warrant(id))
      .filter((warrant) => warrant !== null)
      .map((warrant) => ({
        agentId: warrant.agentId,
        warrantId: warrant.id,
        live: plane.registry.isLive(warrant),
        expiresAt: warrant.expiresAt,
      })),
  });

  /**
   * Everything the share dialog renders for one document.
   *
   * Scoped, like every other listing here: you see a document's sharing state
   * only if you already hold something on that document. An ACL readable by
   * strangers is a directory of who to social-engineer.
   */
  app.get("/api/share/docs/:docId", async (request) => {
    const human = requireHuman(request);
    const { docId } = docParams.parse(request.params);

    const held = heldScopes(plane.registry, human.id, docId);
    const grant = plane.shares.forDocAndGrantee(docId, human.id);
    if (held.size === 0 && !grant) {
      throw new HttpError(403, "You do not have access to that document");
    }

    const maxRole = maxShareableRole(plane.registry, human.id, docId);
    return {
      docId,
      resource: docResource(docId),
      viewer: human.id,
      /** What the viewer holds, so the dialog can disable what it must. */
      canShare: maxRole !== null,
      maxRole,
      heldScopes: [...held],
      grants: plane.shares.forDoc(docId).map(describe),
      /** Candidates for the "add people" box, minus those already on it. */
      people: plane.registry
        .listHumans()
        .filter((candidate) => candidate.id !== human.id)
        .map((candidate) => ({
          id: candidate.id,
          handle: candidate.handle,
          displayName: candidate.displayName,
        })),
    };
  });

  /** Documents other people have shared with me. The "Shared with me" list. */
  app.get("/api/share/mine", async (request) => {
    const human = requireHuman(request);
    return {
      viewer: human.id,
      grants: plane.shares.forGrantee(human.id).map(describe),
    };
  });

  /**
   * Share a document. The interesting half is the denial: a caller who does not
   * hold write on this document, or who asks for a role wider than their own,
   * gets a 403 whose reason names the missing scopes - and that refusal is in
   * the audit chain next to every other decision.
   */
  app.post("/api/share/docs/:docId", async (request, reply) => {
    const human = requireHuman(request);
    const { docId } = docParams.parse(request.params);
    const body = shareBody.parse(request.body);

    const decision = canShare(
      plane.registry,
      human.id,
      body.granteeId,
      docId,
      body.role,
    );
    plane.record({
      humanId: human.id,
      agentId: null,
      action: "workspace.write",
      resource: docResource(docId),
      decision: decision.allowed ? "Allow" : "Deny",
      ruleId: decision.ruleId,
      reason: decision.reason,
      warrantId: null,
    });
    if (!decision.allowed) throw new HttpError(403, decision.reason);

    const grant = plane.shares.grant({
      docId,
      grantedBy: human.id,
      granteeId: body.granteeId,
      role: body.role,
      ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
    });
    return reply.code(201).send({ grant: describe(grant) });
  });

  /**
   * The grantee attaches one of their OWN Agents, and authority finally exists.
   *
   * Only the grantee may call this. If the sharer could attach an Agent on the
   * grantee's behalf, the sharer would be choosing which Agent acts for someone
   * else - which is the exact confusion the warrant model exists to prevent.
   */
  app.post("/api/share/grants/:grantId/agent", async (request, reply) => {
    const human = requireHuman(request);
    const { grantId } = grantParams.parse(request.params);
    const { agentId } = attachBody.parse(request.body);

    const grant = plane.shares.get(grantId);
    if (!grant || !plane.shares.isLive(grant)) {
      throw new HttpError(404, "No live grant with that id");
    }
    if (grant.granteeId !== human.id) {
      plane.record({
        humanId: human.id,
        agentId,
        action: "workspace.write",
        resource: docResource(grant.docId),
        decision: "Deny",
        ruleId: "WB-16.attach-not-grantee",
        reason: "Only the person a document was shared with may attach an Agent to it",
        warrantId: null,
      });
      throw new HttpError(403, "That grant was not made to you");
    }

    const warrant = plane.shares.attachAgent(grantId, agentId);
    if (!warrant) throw new HttpError(409, "That grant is no longer live");

    plane.record({
      humanId: human.id,
      agentId,
      action: "workspace.read",
      resource: docResource(grant.docId),
      decision: "Allow",
      ruleId: "WB-0.share-agent-attached",
      reason:
        "Warrant minted from share " +
        grant.id +
        " at role " +
        grant.role +
        ", expiring with the grant",
      warrantId: warrant.id,
    });

    return reply.code(201).send({ grant: describe(grant), warrantId: warrant.id });
  });

  /**
   * Withdraw a share. The sharer may take access back; the grantee may hand it
   * back. Nobody else can touch it, and every warrant the grant minted dies at
   * the same instant - see ShareRegistry.revoke.
   */
  app.post("/api/share/grants/:grantId/revoke", async (request) => {
    const human = requireHuman(request);
    const { grantId } = grantParams.parse(request.params);
    const { reason } = unshareBody.parse(request.body ?? {});

    const grant = plane.shares.get(grantId);
    if (!grant) throw new HttpError(404, "No grant with that id");

    const allowed = grant.grantedBy === human.id || grant.granteeId === human.id;
    plane.record({
      humanId: human.id,
      agentId: null,
      action: "workspace.write",
      resource: docResource(grant.docId),
      decision: allowed ? "Allow" : "Deny",
      ruleId: allowed ? "WB-0.unshare-party" : "WB-17.unshare-not-a-party",
      reason: allowed
        ? "A share may be withdrawn by either party to it"
        : "You are neither the sharer nor the recipient of that grant",
      warrantId: null,
    });
    if (!allowed) throw new HttpError(403, "That grant is not yours to revoke");

    plane.shares.revoke(grantId, reason);
    return { grant: describe(grant) };
  });

  app.log.info(
    { orchestrator: ORCHESTRATOR_ID },
    "WARRANT (Track B) routes registered",
  );
}
