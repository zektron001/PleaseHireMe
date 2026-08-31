/**
 * What the live surfaces cost.
 *
 * These are the two things that run CONTINUOUSLY rather than once per turn, so
 * they are the ones that can quietly spoil a demo: the activity bus fans every
 * Codex event out to every connected browser, and `/api/live/board` is polled
 * every two seconds by each of them. A per-turn cost is amortised over fifteen
 * seconds of model time; a per-poll cost is paid forever.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { AgentService } from "../agent-service.js";
import type { AgentRunner } from "../types.js";
import { MOCK_HUMANS, WarrantPlane } from "../warrant/index.js";
import { ActivityBus } from "./activity.js";
import { flushMeasurements, measure, MEASUREMENT_FILE } from "../testing/measure.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const runner: AgentRunner = {
  run: async () => ({ output: "done", threadId: null, usage: null }),
  cancel: async () => true,
  isAvailable: async () => true,
};

let dir = "";
let app: FastifyInstance;
let plane: WarrantPlane;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "perf-live-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dir,
    AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
    CODEX_HOME: path.join(dir, "codex-home"),
    AEGIS_ENABLED: "false",
  } as NodeJS.ProcessEnv);
  plane = await WarrantPlane.bootstrap(config, undefined, MOCK_HUMANS);
  app = await createApp(config, service, undefined, plane, runner);
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

afterAll(async () => {
  await flushMeasurements(MEASUREMENT_FILE);
});

describe("the activity bus", () => {
  it("fans one event out to many watchers without stalling the run", async () => {
    const bus = new ActivityBus();
    const WATCHERS = 50;
    let delivered = 0;
    for (let i = 0; i < WATCHERS; i += 1) bus.subscribe(() => (delivered += 1));

    const result = await measure(
      {
        name: "live.fanout.50-watchers",
        claim: "Publishing one Agent event to 50 connected browsers.",
        budgetMs: 2,
        runs: 500,
        justification:
          "This runs on the Agent's own thread of control: the tap sits in " +
          "`inspect`, which the runner calls for every line Codex emits, so a " +
          "slow fan-out would slow the AGENT down rather than the UI. At " +
          "microseconds for fifty subscribers that is not a risk, and the " +
          "design keeps it that way — a subscriber that throws is dropped " +
          "rather than retried, and nothing here awaits anything.",
      },
      () => {
        bus.publish({
          agentId: "agent_a",
          subtaskId: "sub_1",
          humanId: "human:alice",
          purpose: "turn",
          kind: "command",
          detail: "Ran npm test",
        });
      },
    );
    expect(result.p95).toBeLessThan(result.budgetMs);
    expect(delivered).toBeGreaterThan(0);
  });

  it("keeps a bounded history no matter how long a run goes on", async () => {
    const bus = new ActivityBus();
    for (let i = 0; i < 5_000; i += 1) {
      bus.publish({
        agentId: "agent_a",
        subtaskId: null,
        humanId: null,
        purpose: "turn",
        kind: "thinking",
        detail: "step " + i,
      });
    }
    // The ring is what stops a long-running server growing without bound. It
    // is a memory claim rather than a latency one, but it belongs in this lane
    // because it is the reason the fan-out number stays flat over hours.
    expect(bus.history(10_000).length).toBeLessThanOrEqual(300);
  });
});

describe("the board poll", () => {
  it("composes the whole collaboration board inside its budget", async () => {
    const token = (
      await app.inject({
        method: "POST",
        url: "/api/warrant/session",
        payload: { handle: "alice" },
      })
    ).json().token as string;

    // A realistic session: several Agents, each with a section, plus documents.
    await app.inject({
      method: "POST",
      url: "/api/warrant/tasks",
      headers: { authorization: "Bearer " + token },
      payload: {
        title: "Board composition fixture",
        owners: ["human:alice", "human:bob"],
        maxSubtasks: 4,
        sharedPaths: ["docs/BOARD.md"],
      },
    });

    const result = await measure(
      {
        name: "live.board.poll",
        claim:
          "One /api/live/board request — what every open browser asks for every two seconds.",
        budgetMs: 40,
        runs: 200,
        justification:
          "The board holds no state of its own: it composes sessions from the " +
          "orchestrator, roles from the Registry's warrants, conflicts and " +
          "presence from CONCORD, and usage from the bus, on every request. " +
          "That is a deliberate trade — one source of truth per fact, at the " +
          "cost of recomputing them — and this number is what says the trade " +
          "is affordable. At a fortieth of the two-second poll interval, a " +
          "browser spends under two percent of its polling budget here, so " +
          "caching would buy nothing and could serve a stale conflict count.",
      },
      async () => {
        const response = await app.inject({
          method: "GET",
          url: "/api/live/board",
          headers: { authorization: "Bearer " + token },
        });
        expect(response.statusCode).toBe(200);
      },
    );
    expect(result.p95).toBeLessThan(result.budgetMs);
  });

  it("answers a document read fast enough to feel instant", async () => {
    const token = (
      await app.inject({
        method: "POST",
        url: "/api/warrant/session",
        payload: { handle: "alice" },
      })
    ).json().token as string;
    const planned = await app.inject({
      method: "POST",
      url: "/api/warrant/tasks",
      headers: { authorization: "Bearer " + token },
      payload: {
        title: "Read fixture",
        owners: ["human:alice"],
        maxSubtasks: 2,
        sharedPaths: ["docs/READ.md"],
      },
    });
    const agentId = (planned.json().subtasks as { agentId: string }[])[0]!.agentId;

    const result = await measure(
      {
        name: "concord.doc.read",
        claim: "Reading a shared document through the warrant, over HTTP.",
        budgetMs: 30,
        runs: 200,
        justification:
          "A read takes the same per-document lock as a write, so it is on the " +
          "queue behind any commit in flight — that is what makes a read " +
          "consistent with the version it reports rather than a torn view. " +
          "The number here is the uncontended cost, and it is the one the " +
          "editor pays when a human opens a file.",
      },
      async () => {
        const response = await app.inject({
          method: "GET",
          url: "/api/concord/docs/" + encodeURIComponent("docs/READ.md") + "?agentId=" + agentId,
          headers: { authorization: "Bearer " + token },
        });
        expect(response.statusCode).toBe(200);
      },
    );
    expect(result.p95).toBeLessThan(result.budgetMs);
  });
});
