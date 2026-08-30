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
import {
  parseCheckpoint,
  withCheckpointInstruction,
} from "../concord/checkpoint.js";
import { WarrantBindingError } from "./binding.js";
import { activityBus } from "../live/activity.js";
import { watchWorkspaceFile } from "../live/workspace.js";
import type { Subtask, Task } from "./types.js";

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

/** What a finished turn reports, whether it succeeded or fell over. */
interface TurnReport {
  subtaskId: string;
  agentId: string;
  model?: string;
  output?: string;
  error?: string;
  usage?: unknown;
  materialized: unknown;
  reconciled: unknown;
  checkpoint?: string | null;
}

const autorunBody = z.object({
  prompt: z.string().trim().min(1).max(10_000).optional(),
});

const revokeBody = z.object({
  warrantId: z.string().trim().min(1),
  reason: z.string().trim().max(200).default("Revoked by owner"),
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
    // planAllocated, not orchestrator.plan: splitting alone leaves every Agent
    // free to write anywhere in the shared file. This divides it, seeds the
    // headings so each section exists, and registers the allocation CONCORD
    // then enforces.
    const result = await plane.planAllocated({
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
  /**
   * One turn, and the ONLY path that runs one.
   *
   * Extracted so the manual button and auto mode cannot drift apart: "auto"
   * describes who pressed start, not what runs. Same warrant bind, same
   * sandbox, same live tap, same CONCORD reconcile, same evidence.
   */
  const startTurn = async (
    subtask: Subtask,
    human: HumanPrincipal,
    prompt: string,
  ): Promise<TurnReport> => {
    if (!runner) throw new HttpError(503, "No Agent runtime is configured");

    let bound;
    try {
      bound = plane.binder.bind(subtask.agentId, withCheckpointInstruction(prompt));
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

    plane.orchestrator.setState(subtask.id, "in_progress");
    /**
     * The live board taps the same Codex event stream AEGIS already inspects.
     * `prompt` is the human's own words, not the compiled prompt, and it is
     * truncated on the way in - so "what is being asked of this Agent" is
     * answerable without publishing anything the Agent was actually sent.
     */
    const watch = activityBus.watch({
      agentId: subtask.agentId,
      subtaskId: subtask.id,
      humanId: human.id,
      purpose: "turn",
      prompt,
      model: bound.model,
      ...(subtask.sectionDoc ? { docId: subtask.sectionDoc } : {}),
    });
    // Streams the Agent's own workspace copy while it works. This is what the
    // live screens render: the file really is changing on disk as the Agent
    // runs its commands, so nothing about that view is animated.
    const stopWatchingFile = subtask.sectionDoc
      ? watchWorkspaceFile({
          workspacePath,
          docId: subtask.sectionDoc,
          agentId: subtask.agentId,
          subtaskId: subtask.id,
          humanId: human.id,
          ...(subtask.section ? { section: subtask.section } : {}),
        })
      : () => {};

    try {
      const result = await runner.run({ ...bound.request, inspect: watch.inspect });
      watch.finish(result.usage);
      const checkpoint = parseCheckpoint(result.output);
      const reconciled = await plane.reconciler.reconcile(
        workspacePath,
        subtask.agentId,
        shared,
        { message: checkpoint, runId: subtask.id },
      );
      // The turn is over, so the Agent is idle again. Without this the subtask
      // stays "in_progress" for the life of the process: the failure path reset
      // it and the success path never did. "submitted" is a separate step the
      // owner takes; finishing a turn is not submitting it.
      plane.orchestrator.setState(subtask.id, "assigned");
      return {
        subtaskId: subtask.id,
        agentId: subtask.agentId,
        model: bound.model,
        output: result.output,
        usage: result.usage,
        materialized,
        reconciled,
        checkpoint,
      };
    } catch (error) {
      plane.orchestrator.setState(subtask.id, "assigned");
      watch.fail(error instanceof Error ? error.message : String(error));
      // A failed turn may still have left edits on disk. Reconciling anyway is
      // the safe direction: the alternative is silently dropping work that the
      // Agent did before it fell over.
      const reconciled = await plane.reconciler.reconcile(
        workspacePath,
        subtask.agentId,
        shared,
        { message: null, runId: subtask.id },
      );
      return {
        subtaskId: subtask.id,
        agentId: subtask.agentId,
        error: error instanceof Error ? error.message : String(error),
        materialized,
        reconciled,
      };
    } finally {
      stopWatchingFile();
    }
  };

  /** What an Agent is told to do when the human did not say. */
  const defaultPromptFor = (subtask: Subtask, task: Task): string =>
    subtask.section && subtask.sectionDoc
      ? [
          "Edit " + subtask.sectionDoc + " and nothing else.",
          'Work ONLY inside the section headed "' + subtask.section + '".',
          "Replace its placeholder line with your real contribution to: " +
            subtask.description,
          "",
          // Every one of these exists because a real turn was contained for it.
          // The sandbox scans the Agent's shell commands, and a `find` with
          // glob excludes or a `sed` with escaped slashes reads like an escape
          // attempt even when it is not. Giving the Agent no reason to shell
          // out is cheaper and more reliable than widening the policy.
          "Rules:",
          "- Use apply_patch to make the edit. Do not run find, ls, sed or grep.",
          "- Read the file once if you need to; it is at a relative path.",
          "- Never use an absolute path, and never write outside this file.",
          "- Do not change any other section. The middleware will refuse it.",
        ].join("\n")
      : "Work on: " + subtask.description + " (part of " + task.title + ")";

  app.post("/api/warrant/subtasks/:subtaskId/run", async (request, reply) => {
    const human = requireHuman(request);
    const { subtaskId } = subtaskParams.parse(request.params);
    const body = runBody.parse(request.body);

    const subtask = plane.orchestrator.subtask(subtaskId);
    if (!subtask) throw new HttpError(404, "Subtask not found");

    // Spending an Agent's authority is the owner's call. Identity is the
    // session token, so this cannot be bypassed by naming a different human.
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

    const report = await startTurn(subtask, human, body.prompt);
    return reply.code(report.error ? 502 : 200).send(report);
  });

  /**
   * Stop an Agent mid-turn.
   *
   * The runner already knew how to do this - `cancel` force-removes the
   * container or kills the process - it simply had no route. Nothing is
   * reconciled afterwards: a turn the human interrupted has not reached a
   * checkpoint, so offering its half-finished edits to CONCORD would commit
   * work nobody approved. The workspace keeps them; canonical state does not.
   */
  app.post("/api/warrant/subtasks/:subtaskId/stop", async (request) => {
    const human = requireHuman(request);
    const { subtaskId } = subtaskParams.parse(request.params);
    const subtask = plane.orchestrator.subtask(subtaskId);
    if (!subtask) throw new HttpError(404, "Subtask not found");
    if (subtask.ownerId !== human.id) {
      throw new HttpError(403, "Only " + subtask.ownerId + " may stop this Agent");
    }
    if (!runner) throw new HttpError(503, "No Agent runtime is configured");

    const stopped = await runner.cancel(subtask.agentId);
    plane.record({
      humanId: human.id,
      agentId: subtask.agentId,
      action: "workspace.write",
      resource: workspaceResource(subtaskId),
      decision: "Allow",
      ruleId: "WB-0.owner-stops-agent",
      reason: stopped
        ? "The accountable human interrupted their own Agent"
        : "Stop requested; the Agent was not running",
      warrantId: subtask.warrantId,
    });
    activityBus.publish({
      agentId: subtask.agentId,
      subtaskId,
      humanId: human.id,
      purpose: "turn",
      kind: "blocked",
      detail: stopped ? "Stopped by you" : "Stop requested; nothing was running",
    });
    // The run route's own catch resets the state, but a cancel that raced a
    // finished turn would otherwise leave it claimed.
    if (!stopped && subtask.state === "in_progress") {
      plane.orchestrator.setState(subtaskId, "assigned");
    }
    return { stopped, subtask: plane.orchestrator.subtask(subtaskId) };
  });

  /**
   * Auto mode: start every idle Agent on this task at once.
   *
   * Returns as soon as the turns are launched rather than when they finish, so
   * the browser can watch them on the live feed instead of holding a request
   * open for a minute. Each turn takes exactly the same path as the manual
   * button - same warrant bind, same sandbox, same CONCORD reconcile - because
   * "auto" describes who pressed start, not what runs.
   */
  app.post("/api/warrant/tasks/:taskId/autorun", async (request, reply) => {
    const human = requireHuman(request);
    const { taskId } = taskParams.parse(request.params);
    const body = autorunBody.parse(request.body ?? {});
    const task = plane.orchestrator.task(taskId);
    if (!task) throw new HttpError(404, "Task not found");
    if (!runner) throw new HttpError(503, "No Agent runtime is configured");

    const eligible = plane.orchestrator
      .subtasksOf(taskId)
      .filter((subtask) => subtask.ownerId === human.id)
      .filter((subtask) => subtask.state === "assigned");

    if (eligible.length === 0) {
      return reply.code(200).send({ started: [], reason: "No idle Agent to start" });
    }

    for (const subtask of eligible) {
      // Deliberately not awaited: these run in parallel, which is the whole
      // point. Failures land on the live feed and in the chain like any other.
      void startTurn(subtask, human, body.prompt ?? defaultPromptFor(subtask, task));
    }
    return reply.code(202).send({
      started: eligible.map((subtask) => ({
        subtaskId: subtask.id,
        agentId: subtask.agentId,
        title: subtask.title,
      })),
    });
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

  app.log.info(
    { orchestrator: ORCHESTRATOR_ID },
    "WARRANT (Track B) routes registered",
  );
}
