/**
 * The review loop over the real HTTP surface.
 *
 * Nothing is stubbed except Codex itself: the routes, the WARRANT session and
 * PDP, CONCORD's store and the provenance that routes a comment are all the
 * production code path.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { AgentService } from "../agent-service.js";
import type { AgentRunner, RunnerRequest } from "../types.js";
import { WarrantPlane } from "../warrant/index.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const SHARED = "docs/CHANGELOG.md";

let dir = "";
let app: FastifyInstance;
let plane: WarrantPlane;
let turn: (request: RunnerRequest) => Promise<void> = async () => {};

const runner: AgentRunner = {
  run: async (request) => {
    await turn(request);
    return { output: "turn complete", threadId: null, usage: null };
  },
  cancel: async () => true,
  isAvailable: async () => true,
};

interface Planned {
  id: string;
  ownerId: string;
  agentId: string;
  paths: string[];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "review-http-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dir,
    AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
    CODEX_HOME: path.join(dir, "codex-home"),
    AEGIS_ENABLED: "false",
  } as NodeJS.ProcessEnv);
  plane = await WarrantPlane.bootstrap(config);
  turn = async () => {};
  app = await createApp(config, service, undefined, plane, runner);
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

const login = async (handle: string): Promise<string> =>
  (await app.inject({ method: "POST", url: "/api/warrant/session", payload: { handle } }))
    .json().token as string;

async function planShared(): Promise<Planned[]> {
  const result = await plane.orchestrator.plan({
    title: "Add rate limiting to the API",
    createdBy: "human:alice",
    owners: ["human:alice", "human:bob"],
    maxSubtasks: 2,
    sharedPaths: [SHARED],
  });
  return result.subtasks as unknown as Planned[];
}

const write = (agentId: string, expectedVersion: number, content: string) =>
  app.inject({
    method: "POST",
    url: "/api/concord/docs/" + encodeURIComponent(SHARED),
    payload: { agentId, expectedVersion, content },
  });

const comment = (token: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/api/review/docs/" + encodeURIComponent(SHARED) + "/comments",
    headers: { authorization: "Bearer " + token },
    payload,
  });

describe("review routes over HTTP", () => {
  it("accepts a session token even when a shared demo token is configured", async () => {
    // Regression: the review routes were not in the shared-token exemption
    // list, so with APP_AUTH_TOKEN set the gate rejected the per-human session
    // token before requireHuman ever saw it. Every other test runs without a
    // shared token, which is exactly why this went unnoticed until the app was
    // started for real.
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

    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const token = await login("alice");
    await write(alice.agentId, 0, "# Changelog\n\n- entry one");

    const created = await comment(token, {
      startLine: 3,
      endLine: 3,
      body: "works with a shared token configured",
    });
    expect(created.statusCode).toBe(201);

    // And a request with neither token is still refused.
    const anonymous = await app.inject({
      method: "POST",
      url: "/api/review/docs/" + encodeURIComponent(SHARED) + "/comments",
      payload: { startLine: 3, endLine: 3, body: "no identity" },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("requires a session; a comment cannot be left anonymously", async () => {
    await planShared();
    const denied = await app.inject({
      method: "POST",
      url: "/api/review/docs/" + encodeURIComponent(SHARED) + "/comments",
      payload: { startLine: 1, endLine: 1, body: "who am I?" },
    });
    expect(denied.statusCode).toBe(401);
  });

  it("derives the anchor server-side and routes to the Agent that wrote the lines", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const token = await login("alice");

    await write(alice.agentId, 0, "# Changelog\n\n- entry one\n- entry two");

    const created = await comment(token, {
      startLine: 3,
      endLine: 3,
      body: "Spell out what changed.",
    });
    expect(created.statusCode).toBe(201);

    const body = created.json().comment;
    expect(body.responsibleAgentId).toBe(alice.agentId);
    expect(body.selectedText).toBe("- entry one");
    expect(body.selectedTextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.createdByHumanId).toBe("human:alice");
    expect(body.baseVersion).toBe(1);
  });

  it("ignores a selectedText the caller tries to supply", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const token = await login("alice");
    await write(alice.agentId, 0, "# Changelog\n\n- entry one");

    const created = await comment(token, {
      startLine: 3,
      endLine: 3,
      body: "check this",
      selectedText: "something that was never in the file",
      selectedTextHash: "0".repeat(64),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().comment.selectedText).toBe("- entry one");
  });

  it("reports blame for every line, gated by the warrant", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    await write(alice.agentId, 0, "# Changelog\n\n- entry one");

    const blame = await app.inject({
      method: "GET",
      url:
        "/api/concord/docs/" + encodeURIComponent(SHARED) + "/blame?agentId=" + alice.agentId,
    });
    expect(blame.statusCode).toBe(200);
    const lines = blame.json().lines as { lastModifiedByAgentId: string | null }[];
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.lastModifiedByAgentId === alice.agentId)).toBe(true);

    // An Agent with no warrant for this document learns nothing about it.
    const denied = await app.inject({
      method: "GET",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED) + "/blame?agentId=agent:stranger",
    });
    expect(denied.statusCode).toBe(403);
  });

  it("exposes the Agent-authored commit log", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    await write(alice.agentId, 0, "# Changelog\n\n- entry one");

    const log = await app.inject({
      method: "GET",
      url:
        "/api/concord/docs/" +
        encodeURIComponent(SHARED) +
        "/contributions?agentId=" +
        alice.agentId,
    });
    expect(log.statusCode).toBe(200);
    const contributions = log.json().contributions as { agentId: string }[];
    expect(contributions).toHaveLength(1);
    expect(contributions[0]?.agentId).toBe(alice.agentId);
  });

  it("refuses to guess when several Agents wrote the range", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const bob = subtasks[1] as Planned;
    const token = await login("alice");

    await write(alice.agentId, 0, "line A\nline B");
    await write(bob.agentId, 1, "line A\nline B by bob");

    const ambiguous = await comment(token, {
      startLine: 1,
      endLine: 2,
      body: "these disagree",
    });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json().error).toMatch(/choose one explicitly/i);
  });

  it("will not resolve another reviewer's comment", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const aliceToken = await login("alice");
    const bobToken = await login("bob");
    await write(alice.agentId, 0, "# Changelog\n\n- entry one");

    const created = await comment(aliceToken, {
      startLine: 3, endLine: 3, body: "mine",
    });
    const id = created.json().comment.id as string;

    const denied = await app.inject({
      method: "POST",
      url: "/api/review/comments/" + id + "/resolve",
      headers: { authorization: "Bearer " + bobToken },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "POST",
      url: "/api/review/comments/" + id + "/resolve",
      headers: { authorization: "Bearer " + aliceToken },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().comment.status).toBe("resolved");
  });

  it("holds a stale comment instead of sending it to an Agent", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const token = await login("alice");
    await write(alice.agentId, 0, "# Changelog\n\n- entry one");

    const created = await comment(token, {
      startLine: 3, endLine: 3, body: "reword this",
    });
    const id = created.json().comment.id as string;

    // The line the comment was anchored to changes underneath it.
    await write(alice.agentId, 1, "# Changelog\n\n- entry one, reworded already");

    const attempted = await app.inject({
      method: "POST",
      url: "/api/review/reiterations",
      headers: { authorization: "Bearer " + token },
      payload: { commentIds: [id] },
    });
    expect(attempted.statusCode).toBe(409);
    expect(attempted.json().error).toMatch(/stale/i);

    const listed = await app.inject({
      method: "GET",
      url:
        "/api/review/docs/" +
        encodeURIComponent(SHARED) +
        "/comments?agentId=" +
        alice.agentId,
      headers: { authorization: "Bearer " + token },
    });
    const comments = listed.json().comments as { status: string }[];
    expect(comments[0]?.status).toBe("stale");
  });

  it("runs a re-iteration and lands the Agent's revision through CONCORD", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const token = await login("alice");
    await write(alice.agentId, 0, "# Changelog\n\n- entry one");

    const created = await comment(token, {
      startLine: 3, endLine: 3, body: "Say which endpoint changed.",
    });
    const id = created.json().comment.id as string;

    // The Agent edits the shared file in its workspace, as a real turn would.
    turn = async (request) => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const target = path.join(request.workspacePath, SHARED);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "# Changelog\n\n- entry one: /api/limit now rate limited", "utf8");
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/review/reiterations",
      headers: { authorization: "Bearer " + token },
      payload: { commentIds: [id] },
    });
    expect(response.statusCode).toBe(202);
    const runs = response.json().runs as { status: string; resultingVersion: number }[];
    expect(runs).toHaveLength(1);
    expect(["written", "merged"]).toContain(runs[0]?.status);

    // Canonical content really moved, and the comment is addressed - not resolved.
    const doc = await app.inject({
      method: "GET",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED) + "?agentId=" + alice.agentId,
    });
    expect(doc.json().content).toContain("rate limited");

    const listed = await app.inject({
      method: "GET",
      url:
        "/api/review/docs/" +
        encodeURIComponent(SHARED) +
        "/comments?agentId=" +
        alice.agentId,
      headers: { authorization: "Bearer " + token },
    });
    expect((listed.json().comments as { status: string }[])[0]?.status).toBe("addressed");
  });

  it("leaves canonical content untouched when a consultation runs", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const token = await login("alice");
    await write(alice.agentId, 0, "# Changelog\n\n- entry one");

    const before = (
      await app.inject({
        method: "GET",
        url: "/api/concord/docs/" + encodeURIComponent(SHARED) + "?agentId=" + alice.agentId,
      })
    ).json();

    // The Agent misbehaves and rewrites the file during a read-only consultation.
    turn = async (request) => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const target = path.join(request.workspacePath, SHARED);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "hijacked during a consultation", "utf8");
    };

    const asked = await app.inject({
      method: "POST",
      url: "/api/review/consultations",
      headers: { authorization: "Bearer " + token },
      payload: {
        docId: SHARED,
        agentId: alice.agentId,
        startLine: 3,
        endLine: 3,
        question: "Why does this entry exist?",
      },
    });
    expect(asked.statusCode).toBe(200);
    expect(asked.json().consultation.status).toBe("completed");

    const after = (
      await app.inject({
        method: "GET",
        url: "/api/concord/docs/" + encodeURIComponent(SHARED) + "?agentId=" + alice.agentId,
      })
    ).json();
    expect(after.version).toBe(before.version);
    expect(after.content).toBe(before.content);
    expect(after.content).not.toContain("hijacked");
  });
});
