/**
 * Review paths must make the same ownership decision as /run, and record it.
 * Regression for a review finding: consultation and re-iteration ran an Agent
 * on nothing but a session token.
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
import { WarrantPlane } from "../warrant/index.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const SHARED = "docs/CHANGELOG.md";
let dir = "";
let app: FastifyInstance;
let plane: WarrantPlane;

const runner: AgentRunner = {
  run: async () => ({ output: "turn complete", threadId: null, usage: null }),
  cancel: async () => true,
  isAvailable: async () => true,
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "review-own-"));
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

describe("review paths enforce Agent ownership", () => {
  it("refuses a consultation against someone else's Agent, and records the denial", async () => {
    const subtasks = await plan();
    const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
    const bobToken = await login("bob");
    await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      payload: { agentId: alice.agentId, expectedVersion: 0, content: "# Changelog\n\n- one" },
    });

    const denied = await app.inject({
      method: "POST",
      url: "/api/review/consultations",
      headers: { authorization: "Bearer " + bobToken },
      payload: {
        docId: SHARED,
        agentId: alice.agentId,
        startLine: 3,
        endLine: 3,
        question: "why?",
      },
    });

    expect(denied.statusCode).toBe(403);
    // The refusal is evidence, not just an HTTP code.
    const chain = await app.inject({
      method: "GET",
      url: "/api/warrant/events",
      headers: { authorization: "Bearer " + bobToken },
    });
    const events = chain.json().events as { verdict: { ruleId: string }; agentId: string }[];
    expect(
      events.some(
        (e) => e.verdict.ruleId === "WB-6.cross-owner" && e.agentId === alice.agentId,
      ),
    ).toBe(true);

    // And Alice's Agent was never occupied by Bob's request.
    expect(plane.orchestrator.subtaskByAgent(alice.agentId)?.state).not.toBe("in_progress");
  });

  it("allows the owner, and records the allow", async () => {
    const subtasks = await plan();
    const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
    const aliceToken = await login("alice");
    await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      payload: { agentId: alice.agentId, expectedVersion: 0, content: "# Changelog\n\n- one" },
    });

    const allowed = await app.inject({
      method: "POST",
      url: "/api/review/consultations",
      headers: { authorization: "Bearer " + aliceToken },
      payload: {
        docId: SHARED,
        agentId: alice.agentId,
        startLine: 3,
        endLine: 3,
        question: "why?",
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().consultation.status).toBe("completed");
  });
});

describe("a finished turn releases the Agent", () => {
  it("returns the subtask to assigned so later work is not refused forever", async () => {
    const subtasks = await plan();
    const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
    const token = await login("alice");

    const first = await app.inject({
      method: "POST",
      url: "/api/warrant/subtasks/" + alice.id + "/run",
      headers: { authorization: "Bearer " + token },
      payload: { prompt: "do the thing" },
    });
    expect(first.statusCode).toBe(200);

    // Regression: the success path never reset the state, so every later
    // consultation and re-iteration returned 409 for the life of the process.
    expect(plane.orchestrator.subtaskByAgent(alice.agentId)?.state).toBe("assigned");

    const second = await app.inject({
      method: "POST",
      url: "/api/warrant/subtasks/" + alice.id + "/run",
      headers: { authorization: "Bearer " + token },
      payload: { prompt: "and again" },
    });
    expect(second.statusCode).toBe(200);
  });
});
