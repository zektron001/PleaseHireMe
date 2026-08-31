/**
 * Agents raising review comments on each other's work.
 *
 * Driven through the real WARRANT plane and the real CONCORD store. The only
 * fake is the model: `reply` is what the stub runner returns, which is exactly
 * the surface a real Codex turn would produce, and applyAuthored is called the
 * way production calls it - in-process, after reconcile.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { AgentService } from "../agent-service.js";
import type { AgentRunner, RunnerRequest } from "../types.js";
import { MOCK_HUMANS, WarrantPlane } from "../warrant/index.js";
import { ReviewService } from "./service.js";
import { applyAuthored } from "./apply-authored.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const SHARED = "docs/CHANGELOG.md";

let dir = "";
let app: FastifyInstance;
let plane: WarrantPlane;
let review: ReviewService;

/** What the fake model says. Set per test. */
let reply = "turn complete";
/** Every prompt the runner was handed, so two can be compared. */
let prompts: string[] = [];

const runner: AgentRunner = {
  run: async (request: RunnerRequest) => {
    prompts.push(request.prompt);
    return { output: reply, threadId: null, usage: null };
  },
  cancel: async () => true,
  isAvailable: async () => true,
};

interface Planned {
  id: string;
  ownerId: string;
  agentId: string;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agent-review-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dir,
    AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
    CODEX_HOME: path.join(dir, "codex-home"),
    AEGIS_ENABLED: "false",
  } as NodeJS.ProcessEnv);
  plane = await WarrantPlane.bootstrap(config, undefined, MOCK_HUMANS);
  review = new ReviewService(plane.docs, Date.now, {});
  reply = "turn complete";
  prompts = [];
  // Same instance the routes use, so a comment raised in-process here is the
  // comment the HTTP dispatch path sees.
  app = await createApp(config, service, undefined, plane, runner, review);
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

/** Both Agents write, so provenance can route a comment to either of them. */
async function seed(alice: Planned, bob: Planned): Promise<void> {
  await plane.docs.write(SHARED, alice.agentId, 0, "alice one\nalice two\n");
  await plane.docs.write(
    SHARED,
    bob.agentId,
    plane.docs.snapshot(SHARED)?.version ?? 1,
    "alice one\nalice two\nbob three\nbob four\n",
  );
}

const raise = (author: Planned, output: string) =>
  applyAuthored({
    plane,
    review,
    docId: SHARED,
    agentId: author.agentId,
    subtaskId: author.id,
    humanId: author.ownerId,
    purpose: "turn",
    output,
  });

describe("an Agent raising a comment on a peer", () => {
  it("routes it by provenance and attributes it to the author's owner", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);

    raise(alice, "CONCORD-REVIEW: L3-L4 bob's lines never handle the empty case");

    const comments = review.listComments(SHARED);
    expect(comments).toHaveLength(1);
    const comment = comments[0]!;
    // Raised BY Alice's Agent, aimed AT Bob's - resolved from provenance, not
    // named by the model.
    expect(comment.createdByAgentId).toBe(alice.agentId);
    expect(comment.responsibleAgentId).toBe(bob.agentId);
    // Accountable to the AUTHOR's owner, not the recipient's. Easy to get
    // backwards, and the ownership rules downstream depend on it.
    expect(comment.createdByHumanId).toBe("human:alice");
    expect(comment.status).toBe("open");
  });

  it("records the author as an Agent in the review event log", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);
    raise(alice, "CONCORD-REVIEW: L3-L4 no empty case");

    const created = review.listEvents(SHARED).find((e) => e.type === "comment.created");
    expect(created?.actorType).toBe("agent");
    expect(created?.actorId).toBe(alice.agentId);
  });

  it("refuses to let an Agent review its own lines", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);

    // Lines 1-2 are Alice's own. Provenance would route this straight back to
    // her, which is a thread with no peer in it.
    raise(alice, "CONCORD-REVIEW: L1-L2 I could do better here");
    expect(review.listComments(SHARED)).toHaveLength(0);
  });

  it("drops a marker aimed at lines nobody wrote, without failing the turn", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);

    // Line 99 does not exist. The turn's own work is already committed, so
    // this must not throw.
    expect(() => raise(alice, "CONCORD-REVIEW: L98-L99 nothing here")).not.toThrow();
    expect(review.listComments(SHARED)).toHaveLength(0);
  });

  it("refuses to comment once the author's warrant is revoked", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);
    const warrant = plane.registry.warrantForAgent(alice.agentId);
    plane.registry.revoke(warrant!.id, alice.ownerId, "test");

    raise(alice, "CONCORD-REVIEW: L3-L4 no empty case");
    expect(review.listComments(SHARED)).toHaveLength(0);
  });
});

describe("dispatching an Agent-authored comment", () => {
  it("lets the RECIPIENT's owner past the author check", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);
    raise(alice, "CONCORD-REVIEW: L3-L4 no empty case");
    const comment = review.listComments(SHARED)[0]!;

    // Bob did not write it and is not its accountable human, so before this
    // change planRuns refused him outright. He owns the Agent being ASKED,
    // which is what entitles him to spend it.
    expect(
      review.planRuns([comment.id], "human:bob", (id) => id === bob.agentId),
    ).toHaveLength(1);
  });

  it("still refuses Alice at the route, because she does not own the recipient", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);
    raise(alice, "CONCORD-REVIEW: L3-L4 no empty case");
    const comment = review.listComments(SHARED)[0]!;

    // planRuns lets Alice through - her Agent raised it, so she IS its
    // accountable human. What stops her spending BOB's Agent is
    // requireOwnership on the route, which is also what writes WB-6 to the
    // chain. The guarantee lives in the pair, so it is asserted over HTTP.
    const token = await login("alice");
    const refused = await app.inject({
      method: "POST",
      url: "/api/review/reiterations",
      headers: { authorization: "Bearer " + token },
      payload: { commentIds: [comment.id] },
    });
    expect(refused.statusCode).toBe(403);

    // The refusal is evidence, not just a status code: the chain names who
    // tried to direct whose Agent.
    const rules = plane.audit
      .recent(200)
      .map((entry) => (entry as { verdict?: { ruleId?: string } }).verdict?.ruleId);
    expect(rules).toContain("WB-6.cross-owner");
  });

  it("does NOT relax the rule for a human's own comment", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);
    const own = review.createComment({
      docId: SHARED,
      startLine: 3,
      endLine: 4,
      body: "please handle the empty case",
      humanId: "human:alice",
    });

    // The non-regression that matters most: Bob owns the recipient Agent, and
    // that still does not entitle him to dispatch feedback ALICE wrote.
    expect(() =>
      review.planRuns([own.id], "human:bob", (id) => id === bob.agentId),
    ).toThrow(/another reviewer/);
  });
});

describe("indistinguishable to the Agent being asked", () => {
  /**
   * THE test for the whole feature.
   *
   * "Treat every comment as if a human asked" is not a policy statement here,
   * it is a property of the bytes: the prompt a re-iteration hands the model
   * must not differ by who wrote the comment. One careless `if
   * (comment.createdByAgentId)` inside compileReiterationPrompt would make it
   * false, and nothing else in the suite would notice.
   */
  it("sends the same prompt whether a human or an Agent wrote the comment", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);
    const body = "the empty case is never handled";

    const fromHuman = review.createComment({
      docId: SHARED,
      startLine: 3,
      endLine: 4,
      body,
      humanId: "human:alice",
    });
    raise(alice, "CONCORD-REVIEW: L3-L4 " + body);
    const fromAgent = review
      .listComments(SHARED)
      .find((comment) => comment.createdByAgentId !== null)!;

    const { compileReiterationPrompt } = await import("./reiteration.js");
    const doc = plane.docs.snapshot(SHARED)!;
    expect(compileReiterationPrompt(SHARED, doc.content, doc.version, [fromAgent])).toBe(
      compileReiterationPrompt(SHARED, doc.content, doc.version, [fromHuman]),
    );
  });
});

describe("mutual resolve", () => {
  it("needs BOTH Agents, and only then reaches resolved", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);
    raise(alice, "CONCORD-REVIEW: L3-L4 no empty case");
    const comment = review.listComments(SHARED)[0]!;

    review.agentResolve(comment.id, bob.agentId);
    expect(review.get(comment.id).status).not.toBe("resolved");

    review.agentResolve(comment.id, alice.agentId);
    expect(review.get(comment.id).status).toBe("resolved");
  });

  it("refuses an Agent that is not party to the comment", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);
    raise(alice, "CONCORD-REVIEW: L3-L4 no empty case");
    const comment = review.listComments(SHARED)[0]!;

    expect(() => review.agentResolve(comment.id, "agent_someone_else")).toThrow(
      /not party/,
    );
  });

  it("keeps a human's comment human-resolve-only", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);
    const own = review.createComment({
      docId: SHARED,
      startLine: 3,
      endLine: 4,
      body: "please handle the empty case",
      humanId: "human:alice",
    });

    // The standing rule, untouched: an Agent producing a patch is not a human
    // agreeing the point was handled.
    expect(() => review.agentResolve(own.id, bob.agentId)).toThrow(/Only a human/);
  });
});

describe("escalation to blocked", () => {
  it("hands the comment to a human once the rounds budget is gone", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);
    const capped = new ReviewService(plane.docs, Date.now, { maxAgentRounds: 1 });
    applyAuthored({
      plane,
      review: capped,
      docId: SHARED,
      agentId: alice.agentId,
      subtaskId: alice.id,
      humanId: alice.ownerId,
      purpose: "turn",
      output: "CONCORD-REVIEW: L3-L4 no empty case",
    });
    const comment = capped.listComments(SHARED)[0]!;

    const run = capped.openRun(SHARED, bob.agentId, "human:bob", [comment], 2);
    capped.closeRun(run.id, "written", 3, null);

    // The revision landed, but nobody agreed it settled the point and the
    // budget is spent. That is a disagreement, and it is a human's.
    expect(capped.get(comment.id).status).toBe("blocked");
  });

  it("blocks on a CONCORD conflict rather than leaving it to retry", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);
    raise(alice, "CONCORD-REVIEW: L3-L4 no empty case");
    const comment = review.listComments(SHARED)[0]!;

    const run = review.openRun(SHARED, bob.agentId, "human:bob", [comment], 2);
    review.closeRun(run.id, "conflict", null, "same-line conflict");

    expect(review.get(comment.id).status).toBe("blocked");
  });

  it("leaves a human's comment on the documented status, never blocked", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);
    const own = review.createComment({
      docId: SHARED,
      startLine: 3,
      endLine: 4,
      body: "please handle the empty case",
      humanId: "human:alice",
    });

    const run = review.openRun(SHARED, bob.agentId, "human:alice", [own], 2);
    review.closeRun(run.id, "conflict", null, "same-line conflict");

    expect(review.get(own.id).status).toBe("conflict");
  });

  it("blocks rather than hides an Agent comment whose anchor moved", async () => {
    const [alice, bob] = (await planShared()) as [Planned, Planned];
    await seed(alice, bob);
    raise(alice, "CONCORD-REVIEW: L3-L4 no empty case");
    const comment = review.listComments(SHARED)[0]!;

    review.markStale(comment);

    // NOT "stale": the Review panel filters that out of the open list, and a
    // human would never learn a peer had raised anything.
    expect(review.get(comment.id).status).toBe("blocked");
  });
});
