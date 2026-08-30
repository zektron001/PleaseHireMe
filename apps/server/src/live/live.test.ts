/**
 * The live collaboration plane.
 *
 * The claim being tested is narrow and it is the whole point: what the board
 * shows HAPPENED. So these tests drive real turns through the real run route
 * and then assert the board reports them - rather than publishing synthetic
 * events onto the bus and checking they come back out.
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { AgentService } from "../agent-service.js";
import type { AgentRunner, RunnerRequest } from "../types.js";
import { MOCK_HUMANS, WarrantPlane } from "../warrant/index.js";
import { ActivityBus, parseActivity } from "./activity.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const SHARED = "docs/CHANGELOG.md";
let dir = "";
let app: FastifyInstance;
let plane: WarrantPlane;

/** Emits Codex-shaped JSONL, exactly as the real runners hand it to `inspect`. */
let emits: string[] = [];
let edits: (request: RunnerRequest) => Promise<void> = async () => {};

const runner: AgentRunner = {
  run: async (request) => {
    for (const line of emits) request.inspect?.(line);
    await edits(request);
    return {
      output: "turn complete",
      threadId: null,
      usage: { inputTokens: 1200, outputTokens: 340 },
    };
  },
  cancel: async () => true,
  isAvailable: async () => true,
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "live-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dir,
    AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
    CODEX_HOME: path.join(dir, "codex-home"),
    AEGIS_ENABLED: "false",
  } as NodeJS.ProcessEnv);
  plane = await WarrantPlane.bootstrap(config, undefined, MOCK_HUMANS);
  emits = [];
  edits = async () => {};
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

const board = async (token: string) =>
  (await app.inject({ method: "GET", url: "/api/live/board", headers: bearer(token) })).json();

describe("reading the Codex event stream", () => {
  it("turns the item types a human would want to watch into rows", () => {
    expect(parseActivity('{"type":"turn.started"}')?.kind).toBe("turn-started");
    expect(
      parseActivity(
        '{"type":"item.completed","item":{"type":"command_execution","command":"npm test"}}',
      ),
    ).toEqual({ kind: "command", detail: "Ran npm test" });
    expect(
      parseActivity(
        '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"a.ts"}]}}',
      ),
    ).toEqual({ kind: "file-change", detail: "Edited a.ts" });
  });

  it("ignores anything it cannot read, rather than inventing a row", () => {
    expect(parseActivity("not json")).toBeNull();
    expect(parseActivity('{"type":"something.else"}')).toBeNull();
    expect(parseActivity('{"type":"item.completed","item":{"type":"unknown"}}')).toBeNull();
  });

  it("truncates a long detail instead of publishing a whole file", () => {
    const long = "x".repeat(5_000);
    const row = parseActivity(
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: long } }),
    );
    expect(row?.detail.length).toBeLessThanOrEqual(300);
    expect(row?.detail.endsWith("…")).toBe(true);
  });
});

describe("the tap cannot interfere with the run", () => {
  it("reports true for every line, including ones it does not understand", () => {
    const bus = new ActivityBus();
    const watch = bus.watch({
      agentId: "agent_x",
      subtaskId: null,
      humanId: "human:alice",
      purpose: "turn",
    });
    expect(watch.inspect("not json at all")).toBe(true);
    expect(watch.inspect('{"type":"turn.started"}')).toBe(true);
  });

  it("counts a turn once, not twice, when Codex also reports turn.completed", () => {
    const bus = new ActivityBus();
    const watch = bus.watch({
      agentId: "agent_x",
      subtaskId: null,
      humanId: "human:alice",
      purpose: "turn",
    });
    watch.inspect('{"type":"turn.completed"}');
    watch.finish({ inputTokens: 10, outputTokens: 5 });
    const usage = bus.usageFor(["agent_x"]);
    expect(usage[0]?.turns).toBe(1);
    expect(usage[0]?.inputTokens).toBe(10);
  });
});

describe("the board reports what really happened", () => {
  it("shows the human's prompt, the Agent's real steps, and the reported usage", async () => {
    const subtasks = await plan();
    const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
    const token = await login("alice");

    emits = [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"command_execution","command":"rg rateLimit"}}',
      '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"docs/CHANGELOG.md"}]}}',
    ];
    edits = async (request) => {
      const target = path.join(request.workspacePath, SHARED);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "- rate limiting added", "utf8");
    };

    const run = await app.inject({
      method: "POST",
      url: "/api/warrant/subtasks/" + alice.id + "/run",
      headers: bearer(token),
      payload: { prompt: "Add a changelog line about the rate limiter" },
    });
    expect(run.statusCode).toBe(200);

    const activity = (await board(token)).activity as {
      kind: string;
      detail: string;
      humanId: string;
      purpose: string;
    }[];
    const kinds = activity.map((event) => event.kind);
    expect(kinds).toContain("prompt");
    expect(kinds).toContain("command");
    expect(kinds).toContain("file-change");
    expect(kinds).toContain("turn-completed");

    const prompt = activity.find((event) => event.kind === "prompt");
    expect(prompt?.detail).toContain("rate limiter");
    expect(prompt?.humanId).toBe("human:alice");
    expect(prompt?.purpose).toBe("turn");

    expect(activity.find((event) => event.kind === "command")?.detail).toBe("Ran rg rateLimit");

    const usage = (await board(token)).usage as { turns: number; inputTokens: number }[];
    expect(usage).toHaveLength(1);
    expect(usage[0]?.turns).toBe(1);
    expect(usage[0]?.inputTokens).toBe(1200);
  });

  it("is quiet when the Agents are quiet", async () => {
    await plan();
    const token = await login("alice");
    const result = await board(token);
    expect(result.activity).toEqual([]);
    expect(result.usage).toEqual([]);
  });

  it("shows one human nothing of another human's Agent", async () => {
    const subtasks = await plan();
    const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
    const aliceToken = await login("alice");
    const bobToken = await login("bob");

    emits = ['{"type":"turn.started"}'];
    await app.inject({
      method: "POST",
      url: "/api/warrant/subtasks/" + alice.id + "/run",
      headers: bearer(aliceToken),
      payload: { prompt: "alice's private wording" },
    });

    const mine = (await board(aliceToken)).activity as { agentId: string }[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((event) => event.agentId === alice.agentId)).toBe(true);

    const theirs = (await board(bobToken)).activity as unknown[];
    expect(theirs).toEqual([]);

    // The orchestrator reviews the whole fan-out, so it does see it.
    const all = (await board(await login("orchestrator"))).activity as unknown[];
    expect(all.length).toBeGreaterThan(0);
  });

  it("refuses the board without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/live/board" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses the stream without a session, before a byte is written", async () => {
    // requireHuman throws ahead of writeHead, so this returns like any other
    // route rather than opening a stream nobody is entitled to.
    const res = await app.inject({ method: "GET", url: "/api/live/stream" });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * These use a real socket rather than app.inject, because the bug they exist
 * for lived in the streaming path: inject resolves a handler, it does not hold
 * a connection open while later events are published.
 */
describe("the pushed stream", () => {
  /** Reads SSE data frames until `want` of them arrive, or the timeout. */
  async function collect(
    url: string,
    want: number,
    trigger: () => Promise<unknown>,
    /**
     * A ceiling, not a delay - `pump` resolves the instant `want` frames land,
     * so a generous value costs nothing on the happy path. Generous on purpose:
     * the whole suite runs in parallel, and a tight ceiling here would turn CPU
     * pressure into a flaky failure rather than a real one.
     */
    ceilingMs = 10_000,
  ): Promise<Record<string, unknown>[]> {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: Record<string, unknown>[] = [];
    let buffer = "";

    const pump = (async () => {
      while (events.length < want) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          if (!frame.startsWith("data: ")) continue;
          events.push(JSON.parse(frame.slice(6)) as Record<string, unknown>);
        }
      }
    })();

    await trigger();
    await Promise.race([pump, new Promise((r) => setTimeout(r, ceilingMs))]);
    controller.abort();
    return events;
  }

  it("delivers events for work that begins AFTER the stream opened", async () => {
    // The regression: the viewer's Agent scope was resolved once, when the
    // connection opened. A browser that connected before splitting a task then
    // held an empty scope forever, so every later event was filtered out - the
    // stream stayed up, the keep-alives arrived, and no row was ever delivered.
    // Found by running it against a live model, not by a test, which is why
    // this one uses a real socket.
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const token = await login("alice");

    emits = [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"command_execution","command":"rg limit"}}',
    ];

    const events = await collect(
      address + "/api/live/stream?token=" + token,
      4,
      async () => {
        // Planning happens only now: at connect time this human owned nothing.
        const subtasks = await plan();
        const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
        return app.inject({
          method: "POST",
          url: "/api/warrant/subtasks/" + alice.id + "/run",
          headers: bearer(token),
          payload: { prompt: "add a line" },
        });
      },
    );

    const kinds = events.map((event) => event["kind"]);
    expect(kinds).toContain("prompt");
    expect(kinds).toContain("command");
    expect(kinds).toContain("turn-completed");
  }, 20_000);

  it("does not deliver another human's Agent to a connected viewer", async () => {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const bobToken = await login("bob");
    const aliceToken = await login("alice");

    emits = ['{"type":"turn.started"}'];
    const events = await collect(
      address + "/api/live/stream?token=" + bobToken,
      1,
      async () => {
        const subtasks = await plan();
        const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
        return app.inject({
          method: "POST",
          url: "/api/warrant/subtasks/" + alice.id + "/run",
          headers: bearer(aliceToken),
          payload: { prompt: "alice's private wording" },
        });
      },
      // This one cannot exit early: it is asserting that NOTHING arrives, so
      // the ceiling is the whole cost. Kept short deliberately.
      1_500,
    );
    expect(events).toEqual([]);
  }, 15_000);
});

describe("the board composes existing state rather than holding its own", () => {
  it("names the session, its shared documents and whose Agent is on it", async () => {
    const subtasks = await plan();
    const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
    const token = await login("alice");

    await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      payload: { agentId: alice.agentId, expectedVersion: 0, content: "one" },
      headers: bearer(token),
    });

    const sessions = (await board(token)).sessions as {
      title: string;
      sharedPaths: string[];
      docs: { id: string; version: number }[];
      agents: { agentId: string; mine: boolean }[];
    }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.title).toBe("Add rate limiting");
    expect(sessions[0]?.sharedPaths).toEqual([SHARED]);
    expect(sessions[0]?.docs[0]).toMatchObject({ id: SHARED, version: 1 });
    // Both collaborators are visible; only one of them is Alice's to direct.
    expect(sessions[0]?.agents).toHaveLength(2);
    expect(sessions[0]?.agents.filter((a) => a.mine)).toHaveLength(1);
  });

  it("renders each warrant's scopes as the role it actually grants", async () => {
    await plan();
    const token = await login("alice");
    const people = (await board(token)).people as {
      id: string;
      agents: { role: string; live: boolean; scopes: string[] }[];
    }[];
    const alice = people.find((person) => person.id === "human:alice");
    expect(alice?.agents[0]?.role).toBe("Editor");
    expect(alice?.agents[0]?.live).toBe(true);
    expect(alice?.agents[0]?.scopes).toContain("workspace:write");
  });

  it("puts an open conflict on the queue of the human who must settle it", async () => {
    const subtasks = await plan();
    const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
    const bob = subtasks.find((s) => s.ownerId === "human:bob")!;
    const aliceToken = await login("alice");
    const bobToken = await login("bob");

    const write = (agentId: string, token: string, version: number, content: string) =>
      app.inject({
        method: "POST",
        url: "/api/concord/docs/" + encodeURIComponent(SHARED),
        payload: { agentId, expectedVersion: version, content },
        headers: bearer(token),
      });

    await write(alice.agentId, aliceToken, 0, "- TBD\n");
    await app.inject({
      method: "GET",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED) + "?agentId=" + bob.agentId,
      headers: bearer(bobToken),
    });
    await write(alice.agentId, aliceToken, 1, "- rate limiter\n");
    const losing = await write(bob.agentId, bobToken, 1, "- config validation\n");
    expect(losing.statusCode).toBe(409);

    const queue = (await board(bobToken)).queue as { kind: string; docId: string }[];
    expect(queue.some((row) => row.kind === "conflict" && row.docId === SHARED)).toBe(true);

    // And it is not on Alice's queue: she is not the one who must settle it.
    const aliceQueue = (await board(aliceToken)).queue as { kind: string }[];
    expect(aliceQueue.some((row) => row.kind === "conflict")).toBe(false);
  });

  it("puts an open review comment on the queue, scoped to the responsible Agent's owner", async () => {
    const subtasks = await plan();
    const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
    const aliceToken = await login("alice");
    const bobToken = await login("bob");

    await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      payload: { agentId: alice.agentId, expectedVersion: 0, content: "# Changelog\n\n- one" },
      headers: bearer(aliceToken),
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/review/docs/" + encodeURIComponent(SHARED) + "/comments",
      headers: bearer(aliceToken),
      payload: { startLine: 3, endLine: 3, body: "Name the endpoint." },
    });
    expect(created.statusCode).toBe(201);

    const mine = (await board(aliceToken)).queue as { kind: string; label: string }[];
    expect(mine.some((row) => row.kind === "comment" && row.label === "Name the endpoint.")).toBe(
      true,
    );

    const theirs = (await board(bobToken)).queue as { kind: string }[];
    expect(theirs.some((row) => row.kind === "comment")).toBe(false);
  });
});

describe("the access sheet is a rendering of WARRANT", () => {
  it("shows a human only their own delegations, and marks a revoked one dead", async () => {
    const subtasks = await plan();
    const alice = subtasks.find((s) => s.ownerId === "human:alice")!;
    const token = await login("alice");

    const before = (
      await app.inject({ method: "GET", url: "/api/live/access", headers: bearer(token) })
    ).json().warrants as { agentId: string; live: boolean; revocableByViewer: boolean }[];
    expect(before).toHaveLength(1);
    expect(before[0]?.agentId).toBe(alice.agentId);
    expect(before[0]?.live).toBe(true);
    expect(before[0]?.revocableByViewer).toBe(true);

    const warrantId = plane.registry.warrantForAgent(alice.agentId)!.id;
    await app.inject({
      method: "POST",
      url: "/api/warrant/revoke",
      headers: bearer(token),
      payload: { warrantId, reason: "done" },
    });

    const after = (
      await app.inject({ method: "GET", url: "/api/live/access", headers: bearer(token) })
    ).json().warrants as { live: boolean; revokedReason: string }[];
    expect(after[0]?.live).toBe(false);
    expect(after[0]?.revokedReason).toBe("done");
  });
});
