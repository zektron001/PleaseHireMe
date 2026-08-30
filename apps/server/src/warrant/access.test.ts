/**
 * The hole this file exists for.
 *
 * `/api/warrant/tasks/:id` used to be anonymous, and it returns the `agentId`
 * of every subtask. CONCORD and the review routes used to accept that id as
 * their only identity. So the attack was two unauthenticated GETs and a POST:
 * list the tasks, read an Agent id, write the shared document as that Agent.
 * Setting APP_AUTH_TOKEN did not help, because those routes are exempt from it
 * (they carry a per-human session token in the same header).
 *
 * Every test below is the real HTTP surface. The fix is that an Agent id is now
 * a SELECTOR - it says which of your own delegations to act through - and the
 * human still comes only from the session token.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { AgentService } from "../agent-service.js";
import type { AgentRunner } from "../types.js";
import { WarrantPlane } from "./index.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const runner: AgentRunner = {
  run: async () => ({ output: "turn complete", threadId: null, usage: null }),
  cancel: async () => true,
  isAvailable: async () => true,
};

const SHARED = "docs/CHANGELOG.md";
let dir = "";
let app: FastifyInstance;
let plane: WarrantPlane;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "access-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dir,
    AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
    CODEX_HOME: path.join(dir, "codex-home"),
    AEGIS_ENABLED: "false",
  } as NodeJS.ProcessEnv);
  plane = await WarrantPlane.bootstrap(config);
  app = await createApp(config, service, undefined, plane, runner);
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

const login = async (handle: string): Promise<string> =>
  (await app.inject({ method: "POST", url: "/api/warrant/session", payload: { handle } }))
    .json().token as string;

const bearer = (token: string) => ({ authorization: "Bearer " + token });

interface Planned { id: string; ownerId: string; agentId: string }

async function plan(): Promise<Planned[]> {
  const result = await plane.orchestrator.plan({
    title: "Add rate limiting",
    createdBy: "human:alice",
    owners: ["human:alice", "human:bob"],
    maxSubtasks: 2,
    sharedPaths: [SHARED],
  });
  return result.subtasks as unknown as Planned[];
}

describe("Agent ids are no longer published to anonymous callers", () => {
  it("refuses the task listing without a session", async () => {
    await plan();
    const listed = await app.inject({ method: "GET", url: "/api/warrant/tasks" });
    expect(listed.statusCode).toBe(401);
  });

  it("refuses a single task without a session", async () => {
    const subtasks = await plan();
    const taskId = plane.orchestrator.subtaskByAgent(
      (subtasks[0] as Planned).agentId,
    )!.taskId;
    const res = await app.inject({ method: "GET", url: "/api/warrant/tasks/" + taskId });
    expect(res.statusCode).toBe(401);
  });

  it("hides a task from a signed-in human who is not on it", async () => {
    const subtasks = await plan();
    const taskId = plane.orchestrator.subtaskByAgent(
      (subtasks[0] as Planned).agentId,
    )!.taskId;

    // Alice and Bob are the participants; the orchestrator is neither, but it
    // is allowed to see everything. Use a human who is on no subtask instead.
    const outsider = plane.registry.addHuman("carol", "Carol Nwosu");
    expect(outsider.id).toBe("human:carol");
    const token = await login("carol");

    const listed = await app.inject({
      method: "GET",
      url: "/api/warrant/tasks",
      headers: bearer(token),
    });
    expect(listed.json().tasks).toEqual([]);

    // 404 rather than 403: distinguishing them makes this a task-id oracle.
    const single = await app.inject({
      method: "GET",
      url: "/api/warrant/tasks/" + taskId,
      headers: bearer(token),
    });
    expect(single.statusCode).toBe(404);
  });

  it("refuses the delegation graph without a session", async () => {
    await plan();
    const res = await app.inject({ method: "GET", url: "/api/warrant/status" });
    expect(res.statusCode).toBe(401);
  });
});

describe("a known Agent id grants nothing on its own", () => {
  it("refuses an anonymous read of a shared document", async () => {
    const subtasks = await plan();
    const alice = subtasks[0] as Planned;
    const res = await app.inject({
      method: "GET",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED) + "?agentId=" + alice.agentId,
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses an anonymous WRITE to a shared document", async () => {
    const subtasks = await plan();
    const alice = subtasks[0] as Planned;
    const res = await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      payload: { agentId: alice.agentId, expectedVersion: 0, content: "owned" },
    });
    expect(res.statusCode).toBe(401);

    // Nothing landed: the document was never created.
    expect(plane.docs.snapshot(SHARED)).toBeNull();
  });

  it("refuses a SIGNED-IN human who names an Agent that is not theirs", async () => {
    const subtasks = await plan();
    const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
    const bobToken = await login("bob");

    const written = await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      payload: { agentId: alice.agentId, expectedVersion: 0, content: "bob was here" },
      headers: bearer(bobToken),
    });
    expect(written.statusCode).toBe(403);
    expect(plane.docs.snapshot(SHARED)).toBeNull();

    // The refusal is evidence, and it names both parties.
    const chain = await app.inject({
      method: "GET",
      url: "/api/warrant/events",
      headers: bearer(bobToken),
    });
    const events = chain.json().events as {
      verdict: { ruleId: string };
      evidence: Record<string, string>;
    }[];
    expect(
      events.some(
        (e) =>
          e.verdict.ruleId === "WB-11.agent-not-delegated" &&
          e.evidence["human"] === "human:bob" &&
          e.evidence["agent"] === alice.agentId,
      ),
    ).toBe(true);
  });

  it("refuses an invented Agent id from a signed-in human", async () => {
    await plan();
    const token = await login("alice");
    const res = await app.inject({
      method: "GET",
      url: "/api/concord/docs?agentId=agent_made_up",
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(403);
  });

  it("still lets a human act through their own Agent", async () => {
    const subtasks = await plan();
    const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
    const token = await login("alice");

    const written = await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      payload: { agentId: alice.agentId, expectedVersion: 0, content: "alice was here" },
      headers: bearer(token),
    });
    expect(written.statusCode).toBe(200);
    expect(plane.docs.snapshot(SHARED)?.content).toBe("alice was here");
  });

  it("refuses review state for an Agent the caller does not hold", async () => {
    const subtasks = await plan();
    const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
    const bobToken = await login("bob");
    const res = await app.inject({
      method: "GET",
      url:
        "/api/review/docs/" +
        encodeURIComponent(SHARED) +
        "/comments?agentId=" +
        alice.agentId,
      headers: bearer(bobToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("the orchestrator may name any Agent, because reviewing the fan-out is its job", async () => {
    const subtasks = await plan();
    const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
    const token = await login("orchestrator");
    const res = await app.inject({
      method: "GET",
      url: "/api/concord/docs?agentId=" + alice.agentId,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("the whole original attack, end to end", () => {
  it("cannot be carried out even with the shared demo token configured", async () => {
    // Rebuild with APP_AUTH_TOKEN set: the middleware routes are exempt from
    // it, which is precisely why the delegation gate has to exist.
    await app.close();
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: dir,
      AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
      CODEX_HOME: path.join(dir, "codex-home"),
      AEGIS_ENABLED: "false",
      APP_AUTH_TOKEN: "a-strong-shared-demo-token",
    } as NodeJS.ProcessEnv);
    app = await createApp(config, service, undefined, plane, runner);

    const subtasks = await plan();
    const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
    const aliceToken = await login("alice");
    await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      payload: { agentId: alice.agentId, expectedVersion: 0, content: "# real content" },
      headers: bearer(aliceToken),
    });

    // Step 1: harvest an Agent id anonymously. This is where it now stops.
    const harvested = await app.inject({ method: "GET", url: "/api/warrant/tasks" });
    expect(harvested.statusCode).toBe(401);

    // Step 2: even handed the id, the write is refused and content survives.
    const overwrite = await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      payload: { agentId: alice.agentId, expectedVersion: 1, content: "defaced" },
    });
    expect(overwrite.statusCode).toBe(401);
    expect(plane.docs.snapshot(SHARED)?.content).toBe("# real content");
  });
});
