/**
 * Single-operator orchestration with exclusive section allocation.
 *
 * The claim these lock down: the orchestrator does not merely hand out
 * subtasks, it divides the shared file, and CONCORD then refuses an Agent that
 * reaches outside its own slice. Two Agents on one document at the same time
 * were never able to touch the same lines.
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
  dir = await mkdtemp(path.join(tmpdir(), "alloc-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dir,
    AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
    CODEX_HOME: path.join(dir, "codex-home"),
    AEGIS_ENABLED: "false",
  } as NodeJS.ProcessEnv);
  // The default seed: exactly one human, which is the product's whole model.
  plane = await WarrantPlane.bootstrap(config);
  app = await createApp(config, service, undefined, plane, runner);
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

const login = async (): Promise<string> =>
  (
    await app.inject({
      method: "POST",
      url: "/api/warrant/session",
      payload: { handle: "orchestrator" },
    })
  ).json().token as string;

const bearer = (token: string) => ({ authorization: "Bearer " + token });

async function planned(token: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/warrant/tasks",
    headers: bearer(token),
    payload: {
      title: "Add rate limiting to the API",
      owners: ["human:orchestrator"],
      maxSubtasks: 2,
      sharedPaths: [SHARED],
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as {
    task: { id: string };
    subtasks: { id: string; agentId: string; section: string; sectionDoc: string }[];
  };
}

describe("who the platform seeds", () => {
  /**
   * This asserted exactly ONE human when the orchestration work went
   * single-operator. It seeds several again, and the reason is worth pinning:
   * `warrant/sharing.ts` refuses a grant where the granter IS the grantee and
   * requires the grantee to exist, so a one-human platform makes the share
   * dialog, the shared-with-me inbox and every WB-12/WB-13 rule unreachable.
   *
   * Nothing about section allocation or the orchestration depends on the
   * count, which is why the reversal cost nothing but this test.
   */
  it("seeds enough humans for a grant to have somewhere to go", async () => {
    const humans = (
      await app.inject({ method: "GET", url: "/api/warrant/humans" })
    ).json().humans as { id: string }[];
    expect(humans.length).toBeGreaterThan(1);
    expect(humans.map((human) => human.id)).toContain("human:orchestrator");
  });

  it("still runs the whole allocation flow as a single operator", async () => {
    // The product can be driven by one person; it is not required to be.
    const token = await login();
    const { subtasks } = await planned(token);
    expect(subtasks.every((s) => s.section !== null)).toBe(true);
  });
});

describe("planning divides the document", () => {
  it("gives every subtask its own section, and seeds the headings", async () => {
    const token = await login();
    const { subtasks } = await planned(token);

    expect(subtasks).toHaveLength(2);
    const sections = subtasks.map((s) => s.section);
    expect(new Set(sections).size).toBe(2);
    for (const subtask of subtasks) {
      expect(subtask.sectionDoc).toBe(SHARED);
      expect(subtask.section).toMatch(/^## /);
    }

    // The headings really exist in the canonical document, so each Agent has
    // something to anchor to on its very first turn.
    const content = plane.docs.snapshot(SHARED)?.content ?? "";
    for (const section of sections) expect(content).toContain(section);
  });

  it("registers the allocation with CONCORD", async () => {
    const token = await login();
    const { subtasks } = await planned(token);
    const allocations = plane.docs.sections.listFor(SHARED);
    expect(allocations).toHaveLength(2);
    expect(new Set(allocations.map((a) => a.agentId))).toEqual(
      new Set(subtasks.map((s) => s.agentId)),
    );
  });

  it("does not destroy content a previous plan left behind", async () => {
    const token = await login();
    await planned(token);
    const first = plane.docs.snapshot(SHARED)!.content;

    await planned(token);
    const second = plane.docs.snapshot(SHARED)!.content;
    // Everything from the first plan survives; the second only appends.
    for (const line of first.split("\n").filter(Boolean)) {
      expect(second).toContain(line);
    }
  });
});

describe("an Agent is confined to its own section", () => {
  it("accepts a write inside it and refuses one outside", async () => {
    const token = await login();
    const { subtasks } = await planned(token);
    const [a, b] = subtasks as [typeof subtasks[0], typeof subtasks[0]];

    const doc = plane.docs.snapshot(SHARED)!;
    const mine = doc.content.replace(
      a.section + "\n- (not started)",
      a.section + "\n- a token bucket per IP",
    );
    const ok = await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      headers: bearer(token),
      payload: { agentId: a.agentId, expectedVersion: doc.version, content: mine },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().outcome.status).toBe("written");

    // Now the same Agent reaches into B's section.
    const after = plane.docs.snapshot(SHARED)!;
    const trespass = after.content.replace(
      b.section + "\n- (not started)",
      b.section + "\n- I will do this one too",
    );
    const denied = await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      headers: bearer(token),
      payload: { agentId: a.agentId, expectedVersion: after.version, content: trespass },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().outcome.ruleId).toBe("CD-section.outside");
    expect(plane.docs.snapshot(SHARED)!.content).toBe(after.content);
  });

  it("serves the allocation so the editor can draw the boundaries", async () => {
    const token = await login();
    const { subtasks } = await planned(token);
    const res = await app.inject({
      method: "GET",
      url:
        "/api/concord/docs/" +
        encodeURIComponent(SHARED) +
        "/sections?agentId=" +
        subtasks[0]!.agentId,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().allocations).toHaveLength(2);
  });
});

describe("the human owns the whole file", () => {
  it("saves a direct edit and attributes the lines to the human", async () => {
    const token = await login();
    await planned(token);
    const doc = plane.docs.snapshot(SHARED)!;

    const saved = await app.inject({
      method: "PUT",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      headers: bearer(token),
      payload: {
        expectedVersion: doc.version,
        content: doc.content + "\n## Notes\n- written by hand\n",
        message: "typed in the editor",
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().outcome.status).toBe("written");

    const provenance = plane.docs.provenanceOf(SHARED);
    const byHand = provenance.filter(
      (entry) => entry?.lastModifiedByHumanId === "human:orchestrator",
    );
    expect(byHand.length).toBeGreaterThan(0);
    expect(byHand.every((entry) => entry.lastModifiedByAgentId === null)).toBe(true);
  });

  it("refuses a save against a version that already moved, rather than merging it", async () => {
    const token = await login();
    await planned(token);
    const doc = plane.docs.snapshot(SHARED)!;

    const stale = await app.inject({
      method: "PUT",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      headers: bearer(token),
      payload: { expectedVersion: doc.version - 1, content: "clobbered" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().outcome.status).toBe("stale");
    expect(plane.docs.snapshot(SHARED)!.content).toBe(doc.content);
  });

  it("refuses an anonymous save", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      payload: { expectedVersion: 0, content: "anyone" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("the reviewer confirms an Agent rather than typing its id", () => {
  it("names the Agent responsible for the selected lines", async () => {
    const token = await login();
    const { subtasks } = await planned(token);
    const a = subtasks[0]!;

    const doc = plane.docs.snapshot(SHARED)!;
    const mine = doc.content.replace(
      a.section + "\n- (not started)",
      a.section + "\n- a token bucket per IP",
    );
    await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      headers: bearer(token),
      payload: { agentId: a.agentId, expectedVersion: doc.version, content: mine },
    });

    const line =
      plane.docs.snapshot(SHARED)!.content.split("\n").indexOf("- a token bucket per IP") + 1;
    const routed = await app.inject({
      method: "GET",
      url:
        "/api/review/docs/" +
        encodeURIComponent(SHARED) +
        "/route?agentId=" +
        a.agentId +
        "&startLine=" +
        line +
        "&endLine=" +
        line,
      headers: bearer(token),
    });
    expect(routed.statusCode).toBe(200);
    const body = routed.json();
    expect(body.recommendedAgentId).toBe(a.agentId);
    // Enough to render a confirmation instead of a text box.
    expect(body.recommended.title).toBeTruthy();
    expect(body.recommended.section).toBe(a.section);
    expect(body.recommended.mine).toBe(true);
    expect(body.humanAuthored).toBe(false);
  });

  it("reports human-authored lines as having no responsible Agent", async () => {
    const token = await login();
    const { subtasks } = await planned(token);
    const doc = plane.docs.snapshot(SHARED)!;

    await app.inject({
      method: "PUT",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED),
      headers: bearer(token),
      payload: { expectedVersion: doc.version, content: doc.content + "\n- typed by me\n" },
    });
    const line =
      plane.docs.snapshot(SHARED)!.content.split("\n").indexOf("- typed by me") + 1;

    const routed = await app.inject({
      method: "GET",
      url:
        "/api/review/docs/" +
        encodeURIComponent(SHARED) +
        "/route?agentId=" +
        subtasks[0]!.agentId +
        "&startLine=" +
        line +
        "&endLine=" +
        line,
      headers: bearer(token),
    });
    expect(routed.json().humanAuthored).toBe(true);
    expect(routed.json().recommendedAgentId).toBeNull();
  });
});

describe("stopping and auto mode", () => {
  it("stops an Agent, and records who did it", async () => {
    const token = await login();
    const { subtasks } = await planned(token);
    const res = await app.inject({
      method: "POST",
      url: "/api/warrant/subtasks/" + subtasks[0]!.id + "/stop",
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stopped).toBe(true);

    const chain = await app.inject({
      method: "GET",
      url: "/api/warrant/events",
      headers: bearer(token),
    });
    const events = chain.json().events as { verdict: { ruleId: string } }[];
    expect(events.some((e) => e.verdict.ruleId === "WB-0.owner-stops-agent")).toBe(true);
  });

  it("refuses to stop without a session", async () => {
    const token = await login();
    const { subtasks } = await planned(token);
    const res = await app.inject({
      method: "POST",
      url: "/api/warrant/subtasks/" + subtasks[0]!.id + "/stop",
    });
    expect(res.statusCode).toBe(401);
  });

  it("starts every idle Agent at once and returns without waiting", async () => {
    const token = await login();
    const { task, subtasks } = await planned(token);
    const res = await app.inject({
      method: "POST",
      url: "/api/warrant/tasks/" + task.id + "/autorun",
      headers: bearer(token),
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    const started = res.json().started as { subtaskId: string }[];
    expect(started).toHaveLength(subtasks.length);
  });
});
