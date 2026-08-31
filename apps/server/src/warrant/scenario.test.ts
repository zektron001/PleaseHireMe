/**
 * The Track B demo, driven through the real HTTP surface.
 *
 * Everything here goes through `app.inject`, so what is asserted is the actual
 * backend behaviour a judge will exercise from a browser - not an internal
 * function call that a UI could bypass.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { AgentService } from "../agent-service.js";
import { MOCK_HUMANS, WarrantPlane } from "./index.js";
import { workspaceResource } from "./resources.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

let dir = "";
let app: FastifyInstance;
let plane: WarrantPlane;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "warrant-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dir,
    AEGIS_ENABLED: "false",
  } as NodeJS.ProcessEnv);
  plane = await WarrantPlane.bootstrap(config, undefined, MOCK_HUMANS);
  app = await createApp(config, service, undefined, plane);
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

async function login(handle: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/warrant/session",
    payload: { handle },
  });
  expect(res.statusCode).toBe(201);
  return res.json().token as string;
}

interface PlannedSubtask {
  id: string;
  ownerId: string;
  agentId: string;
  model: string;
  warrantId: string;
  paths: string[];
}

async function planTask(token: string): Promise<{
  taskId: string;
  subtasks: PlannedSubtask[];
}> {
  const res = await app.inject({
    method: "POST",
    url: "/api/warrant/tasks",
    headers: { authorization: "Bearer " + token },
    payload: {
      title: "Add rate limiting to the API",
      owners: ["human:alice", "human:bob"],
      maxSubtasks: 3,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { taskId: body.task.id as string, subtasks: body.subtasks };
}

const act = (agentId: string, action: string, resource: string) =>
  app.inject({
    method: "POST",
    url: "/api/warrant/act",
    payload: { agentId, action, resource },
  });

describe("fan-out plan", () => {
  it("gives every subtask a distinct owner, agent, warrant and model", async () => {
    const token = await login("alice");
    const { subtasks } = await planTask(token);

    expect(subtasks).toHaveLength(3);
    expect(new Set(subtasks.map((s) => s.agentId)).size).toBe(3);
    expect(new Set(subtasks.map((s) => s.warrantId)).size).toBe(3);
    // Round-robin across the two owners.
    expect(subtasks.map((s) => s.ownerId)).toEqual([
      "human:alice",
      "human:bob",
      "human:alice",
    ]);
    for (const subtask of subtasks) {
      expect(subtask.model).toBeTruthy();
      expect(subtask.paths.length).toBeGreaterThan(0);
    }
  });

  it("never gives two subtasks the same file", async () => {
    const token = await login("alice");
    const { subtasks } = await planTask(token);
    const all = subtasks.flatMap((s) => s.paths);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("the required Track B demo", () => {
  it("allows an Agent to read its own owner's workspace", async () => {
    const token = await login("alice");
    const { subtasks } = await planTask(token);
    const alices = subtasks[0] as PlannedSubtask;

    const res = await act(
      alices.agentId,
      "workspace.read",
      workspaceResource(alices.id),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().decision.decision).toBe("Allow");
  });

  it("DENIES a cross-owner read in the backend, with full attribution", async () => {
    const token = await login("alice");
    const { subtasks } = await planTask(token);
    const alices = subtasks[0] as PlannedSubtask;
    const bobs = subtasks[1] as PlannedSubtask;

    const res = await act(
      alices.agentId,
      "workspace.read",
      workspaceResource(bobs.id),
    );

    expect(res.statusCode).toBe(403);
    const decision = res.json().decision;
    expect(decision.decision).toBe("Deny");
    expect(decision.ruleId).toBe("WB-6.cross-owner-denied");
    // The five-tuple Track B requires.
    expect(decision.humanId).toBe("human:alice");
    expect(decision.agentId).toBe(alices.agentId);
    expect(decision.action).toBe("workspace.read");
    expect(decision.resource).toBe(workspaceResource(bobs.id));
    expect(decision.warrantId).toBe(alices.warrantId);
  });
});

describe("SUCCESS TEST: a forged identity cannot bypass the decision", () => {
  it("ignores every client-supplied identity hint", async () => {
    const aliceToken = await login("alice");
    const { taskId, subtasks } = await planTask(aliceToken);
    const bobs = subtasks[1] as PlannedSubtask;

    // Alice submits and approves nothing; Bob's subtask is still pending.
    // Alice now tries to integrate while impersonating the orchestrator in
    // every way a browser client could attempt.
    const forged = await app.inject({
      method: "POST",
      url: "/api/warrant/tasks/" + taskId + "/integrate?humanId=human:orchestrator",
      headers: {
        authorization: "Bearer " + aliceToken,
        "x-acting-user": "human:orchestrator",
        "x-user-id": "human:orchestrator",
      },
      payload: { humanId: "human:orchestrator", isOrchestrator: true },
    });

    expect(forged.statusCode).toBe(403);
    const decision = forged.json().decision;
    expect(decision.ruleId).toBe("WB-7.integrate.orchestrator-only");
    // Identity came from the token, so it is still Alice.
    expect(decision.humanId).toBe("human:alice");
  });

  it("rejects a fabricated session token outright", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/warrant/me",
      headers: { authorization: "Bearer human:alice" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("does not let an Agent nominate a warrant it does not hold", async () => {
    const token = await login("alice");
    const { subtasks } = await planTask(token);
    const bobs = subtasks[1] as PlannedSubtask;

    // Ask for Bob's workspace using an agent id that has no warrant at all.
    const res = await act("agent_fabricated", "workspace.read", workspaceResource(bobs.id));
    expect(res.statusCode).toBe(403);
    expect(res.json().decision.ruleId).toBe("WB-1.no-warrant");
  });
});

describe("revocation", () => {
  it("stops a live Agent the moment its owner revokes", async () => {
    const aliceToken = await login("alice");
    const { subtasks } = await planTask(aliceToken);
    const alices = subtasks[0] as PlannedSubtask;
    const own = workspaceResource(alices.id);

    expect((await act(alices.agentId, "workspace.read", own)).statusCode).toBe(200);

    const revoked = await app.inject({
      method: "POST",
      url: "/api/warrant/revoke",
      headers: { authorization: "Bearer " + aliceToken },
      payload: { warrantId: alices.warrantId, reason: "Reassigning this subtask" },
    });
    expect(revoked.statusCode).toBe(200);

    const after = await act(alices.agentId, "workspace.read", own);
    expect(after.statusCode).toBe(403);
    expect(after.json().decision.ruleId).toBe("WB-2.warrant-revoked");
    expect(after.json().decision.reason).toContain("Reassigning");
  });

  it("refuses a revocation by a human who did not issue the warrant", async () => {
    const aliceToken = await login("alice");
    const bobToken = await login("bob");
    const { subtasks } = await planTask(aliceToken);
    const alices = subtasks[0] as PlannedSubtask;

    const res = await app.inject({
      method: "POST",
      url: "/api/warrant/revoke",
      headers: { authorization: "Bearer " + bobToken },
      payload: { warrantId: alices.warrantId, reason: "not mine to revoke" },
    });
    expect(res.statusCode).toBe(403);

    // Alice's Agent still works.
    expect(
      (await act(alices.agentId, "workspace.read", workspaceResource(alices.id)))
        .statusCode,
    ).toBe(200);
  });
});

describe("the integration gate", () => {
  it("blocks the orchestrator until every owner has approved", async () => {
    const aliceToken = await login("alice");
    const bobToken = await login("bob");
    const orchToken = await login("orchestrator");
    const { taskId, subtasks } = await planTask(aliceToken);

    for (const subtask of subtasks) {
      await app.inject({
        method: "POST",
        url: "/api/warrant/subtasks/" + subtask.id + "/submit",
      });
    }

    // Nothing approved yet.
    const early = await app.inject({
      method: "POST",
      url: "/api/warrant/tasks/" + taskId + "/integrate",
      headers: { authorization: "Bearer " + orchToken },
    });
    expect(early.statusCode).toBe(403);
    expect(early.json().decision.ruleId).toBe("WB-8.integrate.unapproved-subtask");

    // An owner may not approve someone else's subtask.
    const bobs = subtasks[1] as PlannedSubtask;
    const wrongApprover = await app.inject({
      method: "POST",
      url: "/api/warrant/subtasks/" + bobs.id + "/approve",
      headers: { authorization: "Bearer " + aliceToken },
    });
    expect(wrongApprover.statusCode).toBe(403);

    // Each owner approves their own.
    for (const subtask of subtasks) {
      const token = subtask.ownerId === "human:alice" ? aliceToken : bobToken;
      const res = await app.inject({
        method: "POST",
        url: "/api/warrant/subtasks/" + subtask.id + "/approve",
        headers: { authorization: "Bearer " + token },
      });
      expect(res.statusCode).toBe(200);
    }

    const integrated = await app.inject({
      method: "POST",
      url: "/api/warrant/tasks/" + taskId + "/integrate",
      headers: { authorization: "Bearer " + orchToken },
    });
    expect(integrated.statusCode).toBe(200);
    expect(integrated.json().task.state).toBe("integrated");
  });
});

describe("evidence", () => {
  it("records every decision in a valid hash chain", async () => {
    const token = await login("alice");
    const { subtasks } = await planTask(token);
    const alices = subtasks[0] as PlannedSubtask;
    const bobs = subtasks[1] as PlannedSubtask;

    await act(alices.agentId, "workspace.read", workspaceResource(alices.id));
    await act(alices.agentId, "workspace.read", workspaceResource(bobs.id));

    const res = await app.inject({
      method: "GET",
      url: "/api/warrant/events",
      headers: { authorization: "Bearer " + (await login("orchestrator")) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chainValid).toBe(true);

    const denial = body.events.find(
      (e: { verdict: { ruleId: string } }) =>
        e.verdict.ruleId === "WB-6.cross-owner-denied",
    );
    expect(denial).toBeDefined();
    expect(denial.evidence).toMatchObject({
      human: "human:alice",
      agent: alices.agentId,
      action: "workspace.read",
      decision: "Deny",
    });
  });

  it("detects tampering with the recorded decisions", async () => {
    const token = await login("alice");
    await planTask(token);
    await act("agent_x", "workspace.read", "ws:nope");

    const events = plane.audit.recent();
    expect(plane.audit.verify(events)).toBe(-1);

    const forged = events.map((event, index) =>
      index === 0
        ? { ...event, verdict: { ...event.verdict, decision: "Allow" as const } }
        : event,
    );
    expect(plane.audit.verify(forged)).toBe(0);
  });
});


describe("T7 sensitive trace capture", () => {
  it("refuses the decision log to an unauthenticated caller", async () => {
    const res = await app.inject({ method: "GET", url: "/api/warrant/events" });
    // The log names every human, Agent, resource and denial on the platform.
    expect(res.statusCode).toBe(401);
  });

  it("scopes an ordinary human to decisions they are a party to", async () => {
    const aliceToken = await login("alice");
    const bobToken = await login("bob");
    const { subtasks } = await planTask(aliceToken);
    const alices = subtasks[0] as PlannedSubtask;
    const bobs = subtasks[1] as PlannedSubtask;

    await act(alices.agentId, "workspace.read", workspaceResource(alices.id));
    await act(bobs.agentId, "workspace.read", workspaceResource(bobs.id));

    const asBob = (
      await app.inject({
        method: "GET",
        url: "/api/warrant/events",
        headers: { authorization: "Bearer " + bobToken },
      })
    ).json();

    expect(asBob.scope).toBe("own");
    const actors = new Set(
      asBob.events.map((e: { evidence: { human: string } }) => e.evidence.human),
    );
    expect(actors.has("human:alice")).toBe(false);
  });

  it("gives the orchestrator the whole picture", async () => {
    const aliceToken = await login("alice");
    const orchToken = await login("orchestrator");
    const { subtasks } = await planTask(aliceToken);
    await act((subtasks[0] as PlannedSubtask).agentId, "workspace.read", "ws:x");

    const asOrchestrator = (
      await app.inject({
        method: "GET",
        url: "/api/warrant/events",
        headers: { authorization: "Bearer " + orchToken },
      })
    ).json();

    expect(asOrchestrator.scope).toBe("all");
    expect(asOrchestrator.events.length).toBeGreaterThan(0);
    expect(asOrchestrator.chainValid).toBe(true);
    expect(asOrchestrator.captureLevel).toBe("standard");
  });

  it("verifies the chain over the retained window, not the scoped view", async () => {
    const aliceToken = await login("alice");
    await planTask(aliceToken);
    const asAlice = (
      await app.inject({
        method: "GET",
        url: "/api/warrant/events",
        headers: { authorization: "Bearer " + aliceToken },
      })
    ).json();
    // A filtered slice is not contiguous, so validity must be reported for the
    // full chain rather than the visible subset.
    expect(asAlice.chainValid).toBe(true);
    expect(asAlice.chainAnchor).toBeTruthy();
  });
});
