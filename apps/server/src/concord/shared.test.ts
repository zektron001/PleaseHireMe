/**
 * CONCORD end to end, over the real HTTP surface and the real WARRANT PDP.
 *
 * The two middlewares have to compose: a shared document is writable by several
 * Agents at once (CONCORD), but only by Agents whose warrant covers it (WARRANT),
 * and the authority check has to happen inside the write's critical section or
 * the composition is a TOCTOU.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { readFile, writeFile } from "node:fs/promises";

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

/**
 * Stands in for Codex: it does whatever the test says a turn did, by editing
 * files in the workspace it was given. Everything around it - the warrant bind,
 * the materialize, the reconcile - is the real code path.
 */
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
  warrantId: string;
  paths: string[];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "concord-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dir,
    AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
    CODEX_HOME: path.join(dir, "codex-home"),
    AEGIS_ENABLED: "false",
  } as NodeJS.ProcessEnv);
  plane = await WarrantPlane.bootstrap(config);
  turn = async () => {};
  tokens.clear();
  app = await createApp(config, service, undefined, plane, runner);
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

const login = async (handle: string): Promise<string> =>
    (
      await app.inject({ method: "POST", url: "/api/warrant/session", payload: { handle } })
    ).json().token as string;

/**
 * Every CONCORD route now requires the session of the human who delegated to
 * the Agent being named: an Agent id is a SELECTOR, not a credential. These
 * tests are about the PDP behind that gate, not the gate itself, so they sign
 * in as whoever owns the Agent - and as the orchestrator for the deliberately
 * unwarranted `agent_nobody`, who may name any Agent and still be refused by
 * the PDP, which is the thing under test. The gate itself is tested in
 * access.test.ts.
 */
const tokens = new Map<string, string>();
const sessionFor = async (agentId: string): Promise<string> => {
  const humanId =
    plane.orchestrator.subtaskByAgent(agentId)?.ownerId ?? "human:orchestrator";
  const cached = tokens.get(humanId);
  if (cached) return cached;
  const token = await login(humanId.replace(/^human:/, ""));
  tokens.set(humanId, token);
  return token;
};

const asAgent = async (agentId: string): Promise<Record<string, string>> => ({
  authorization: "Bearer " + (await sessionFor(agentId)),
});

/** Plans a task whose subtasks all share one document. */
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

const read = async (agentId: string, docId = SHARED) =>
  app.inject({
    method: "GET",
    url: "/api/concord/docs/" + encodeURIComponent(docId) + "?agentId=" + agentId,
    headers: await asAgent(agentId),
  });

const write = async (
  agentId: string,
  expectedVersion: number,
  content: string,
  docId = SHARED,
) =>
  app.inject({
    method: "POST",
    url: "/api/concord/docs/" + encodeURIComponent(docId),
    payload: { agentId, expectedVersion, content },
    headers: await asAgent(agentId),
  });

describe("a shared document both Agents may write", () => {
  it("lets each Agent read it, because the warrant covers it", async () => {
    const subtasks = await planShared();
    for (const subtask of subtasks) {
      const res = await read(subtask.agentId);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("ok");
    }
  });

  it("merges concurrent edits to different regions", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const bob = subtasks[1] as Planned;

    await write(alice.agentId, 0, "# Changelog\n\n- entry one\n- entry two\n- entry three");
    await read(alice.agentId);
    await read(bob.agentId);

    const v = (await read(alice.agentId)).json().version as number;

    // Alice edits the top entry, Bob the bottom one, both from version v.
    const a = await write(
      alice.agentId,
      v,
      "# Changelog\n\n- ALICE\n- entry two\n- entry three",
    );
    const b = await write(
      bob.agentId,
      v,
      "# Changelog\n\n- entry one\n- entry two\n- BOB",
    );

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json().outcome.status).toBe("merged");

    const final = (await read(alice.agentId)).json().content as string;
    expect(final).toContain("ALICE");
    expect(final).toContain("BOB");
  });

  it("returns 409 and keeps both sides when they touch the same line", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const bob = subtasks[1] as Planned;

    await write(alice.agentId, 0, "# Changelog\n\n- TBD");
    await read(alice.agentId);
    await read(bob.agentId);
    const v = (await read(alice.agentId)).json().version as number;

    await write(alice.agentId, v, "# Changelog\n\n- rate limiting by Alice");
    const clash = await write(bob.agentId, v, "# Changelog\n\n- rate limiting by Bob");

    expect(clash.statusCode).toBe(409);
    const outcome = clash.json().outcome;
    expect(outcome.status).toBe("conflict");
    expect(outcome.conflicts[0].ours).toEqual(["- rate limiting by Bob"]);
    expect(outcome.conflicts[0].theirs).toEqual(["- rate limiting by Alice"]);
    // Alice's committed work is intact.
    expect(outcome.content).toContain("Alice");
  });

  it("attributes every version to the human behind the Agent", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const bob = subtasks[1] as Planned;

    await write(alice.agentId, 0, "one");
    await read(bob.agentId);
    await write(bob.agentId, 1, "one\ntwo");

    const history = (
      await app.inject({
        method: "GET",
        url:
          "/api/concord/docs/" +
          encodeURIComponent(SHARED) +
          "/history?agentId=" +
          alice.agentId,
        headers: await asAgent(alice.agentId),
      })
    ).json().history;

    expect(history.map((h: { humanId: string }) => h.humanId)).toEqual([
      "human:alice",
      "human:bob",
    ]);
  });
});

describe("WARRANT still governs CONCORD", () => {
  it("denies an Agent whose warrant does not cover the document", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;

    // Not a shared path and not Alice's own file.
    const res = await read(alice.agentId, "src/somebody-elses-file.ts");
    expect(res.statusCode).toBe(403);
  });

  it("denies an Agent with no warrant at all", async () => {
    await planShared();
    const res = await read("agent_nobody");
    expect(res.statusCode).toBe(403);
  });

  it("denies the history of a document the Agent may not read", async () => {
    await planShared();

    // History carries the agent and human behind every version. Gating the
    // content but not its history would leak the cross-owner activity anyway.
    const res = await app.inject({
      method: "GET",
      url:
        "/api/concord/docs/" + encodeURIComponent(SHARED) + "/history?agentId=agent_nobody",
      headers: await asAgent("agent_nobody"),
    });
    expect(res.statusCode).toBe(403);
  });

  it("lists only the documents the calling Agent may read", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;

    await write(alice.agentId, 0, "one");

    const mine = await app.inject({
      method: "GET",
      url: "/api/concord/docs?agentId=" + alice.agentId,
      headers: await asAgent(alice.agentId),
    });
    expect(mine.json().docs.map((d: { id: string }) => d.id)).toContain(SHARED);

    const theirs = await app.inject({
      method: "GET",
      url: "/api/concord/docs?agentId=agent_nobody",
      headers: await asAgent("agent_nobody"),
    });
    expect(theirs.json().docs).toEqual([]);
  });

  it("honours a revocation that lands between read and write", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;

    await write(alice.agentId, 0, "before");
    const v = (await read(alice.agentId)).json().version as number;

    // The owner revokes while the Agent is preparing its edit.
    plane.registry.revoke(alice.warrantId, alice.ownerId, "reassigned");

    const blocked = await write(alice.agentId, v, "after");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().outcome.ruleId).toBe("WB-2.warrant-revoked");

    // Nothing landed.
    const bob = subtasks[1] as Planned;
    expect((await read(bob.agentId)).json().content).toBe("before");
  });
});

describe("leases over HTTP", () => {
  it("locks a document to one Agent and reports 423 to the others", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const bob = subtasks[1] as Planned;

    const lease = await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED) + "/lease",
      payload: { agentId: alice.agentId, ttlMs: 60_000 },
      headers: await asAgent(alice.agentId),
    });
    expect(lease.statusCode).toBe(200);

    const blocked = await write(bob.agentId, 0, "bob tries");
    expect(blocked.statusCode).toBe(423);
    expect(blocked.json().outcome.holder).toBe(alice.agentId);

    const released = await app.inject({
      method: "DELETE",
      url:
        "/api/concord/docs/" + encodeURIComponent(SHARED) + "/lease?agentId=" + alice.agentId,
      headers: await asAgent(alice.agentId),
    });
    expect(released.json().released).toBe(true);
    expect((await write(bob.agentId, 0, "bob now")).statusCode).toBe(200);
  });

  it("refuses to release a lease for an Agent with no warrant", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const bob = subtasks[1] as Planned;

    await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED) + "/lease",
      payload: { agentId: alice.agentId, ttlMs: 60_000 },
      headers: await asAgent(alice.agentId),
    });

    // A holder id is not a secret. Without authority on the release path,
    // naming the holder would be enough to strip the lease.
    const stripped = await app.inject({
      method: "DELETE",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED) + "/lease?agentId=agent_nobody",
      headers: await asAgent("agent_nobody"),
    });
    expect(stripped.statusCode).toBe(403);

    // The lease survived, so Bob is still locked out.
    expect((await write(bob.agentId, 0, "bob tries again")).statusCode).toBe(423);
  });
});

describe("no lost updates through the API", () => {
  it("survives both Agents writing at once, repeatedly", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const bob = subtasks[1] as Planned;

    await write(alice.agentId, 0, "l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7");

    for (let round = 0; round < 5; round += 1) {
      await read(alice.agentId);
      await read(bob.agentId);
      const v = (await read(alice.agentId)).json().version as number;

      const lines = ((await read(alice.agentId)).json().content as string).split("\n");
      const mine = [...lines];
      mine[0] = "alice-" + round;
      const theirs = [...lines];
      theirs[7] = "bob-" + round;

      const [a, b] = await Promise.all([
        write(alice.agentId, v, mine.join("\n")),
        write(bob.agentId, v, theirs.join("\n")),
      ]);
      // Whatever the ordering, neither request is silently dropped.
      expect([200, 409]).toContain(a.statusCode);
      expect([200, 409]).toContain(b.statusCode);
    }

    const final = (await read(alice.agentId)).json().content as string;
    expect(final).toContain("alice-4");
    expect(final).toContain("bob-4");
  });
});

describe("sharedPaths survives the HTTP boundary", () => {
  /**
   * Regression: the orchestrator accepted `sharedPaths` but the route's Zod
   * schema did not list it, so Zod stripped it and every shared-document write
   * was denied. The unit tests missed this because they call the orchestrator
   * directly. Plan through HTTP, exactly as a client does.
   */
  it("grants the shared document when planning over HTTP", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/warrant/session",
      payload: { handle: "alice" },
    });
    const token = login.json().token as string;

    const planned = await app.inject({
      method: "POST",
      url: "/api/warrant/tasks",
      headers: { authorization: "Bearer " + token },
      payload: {
        title: "Add rate limiting to the API",
        owners: ["human:alice", "human:bob"],
        maxSubtasks: 2,
        sharedPaths: [SHARED],
      },
    });
    expect(planned.statusCode).toBe(201);

    const subtasks = planned.json().subtasks as Planned[];
    for (const subtask of subtasks) {
      const res = await read(subtask.agentId);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("ok");
    }

    // And a path that was NOT shared is still refused.
    const first = subtasks[0] as Planned;
    expect((await read(first.agentId, "docs/NOT_SHARED.md")).statusCode).toBe(403);
  });
});

describe("presence over HTTP", () => {
  it("names the Agents on a document and what each is doing", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const bob = subtasks[1] as Planned;

    await read(bob.agentId);
    await write(alice.agentId, 0, "alice was here");

    const present = (
      await app.inject({
        method: "GET",
        url:
          "/api/concord/docs/" +
          encodeURIComponent(SHARED) +
          "/presence?agentId=" +
          alice.agentId,
        headers: await asAgent(alice.agentId),
      })
    ).json().present as { agentId: string; activity: string }[];

    const byAgent = Object.fromEntries(present.map((p) => [p.agentId, p.activity]));
    expect(byAgent[alice.agentId]).toBe("editing");
    expect(byAgent[bob.agentId]).toBe("viewing");
  });

  it("refuses presence to an Agent with no warrant", async () => {
    await planShared();
    const res = await app.inject({
      method: "GET",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED) + "/presence?agentId=agent_nobody",
      headers: await asAgent("agent_nobody"),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("resolving a conflict is a human decision", () => {
  /** Drives both Agents into a same-line clash and returns the open conflict. */
  const clash = async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const bob = subtasks[1] as Planned;

    await write(alice.agentId, 0, "- TBD\n");
    await read(alice.agentId);
    await read(bob.agentId);
    await write(alice.agentId, 1, "- rate limiter\n");
    const losing = await write(bob.agentId, 1, "- config validation\n");
    expect(losing.statusCode).toBe(409);
    return {
      alice,
      bob,
      conflictId: losing.json().outcome.conflictId as string,
    };
  };

  it("lists the conflict for the human who owns the losing Agent", async () => {
    const { bob, conflictId } = await clash();
    const token = await login("bob");

    const mine = (
      await app.inject({
        method: "GET",
        url: "/api/concord/conflicts",
        headers: { authorization: "Bearer " + token },
      })
    ).json();
    expect(mine.conflicts.map((c: { id: string }) => c.id)).toEqual([conflictId]);
    expect(mine.conflicts[0].agentId).toBe(bob.agentId);
  });

  it("commits the side the owning human picks", async () => {
    const { bob, conflictId } = await clash();
    const token = await login("bob");

    const res = await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED) + "/resolve",
      headers: { authorization: "Bearer " + token },
      payload: { conflictId, choice: "ours" },
    });
    expect(res.statusCode).toBe(200);
    expect((await read(bob.agentId)).json().content).toBe("- config validation\n");
  });

  it("keeps both sides when the human asks for both", async () => {
    const { bob, conflictId } = await clash();
    const token = await login("bob");

    await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED) + "/resolve",
      headers: { authorization: "Bearer " + token },
      payload: { conflictId, choice: "both" },
    });
    const content = (await read(bob.agentId)).json().content as string;
    expect(content).toContain("rate limiter");
    expect(content).toContain("config validation");
  });

  it("refuses a human settling a conflict that is not theirs", async () => {
    const { conflictId } = await clash();
    const token = await login("alice");

    const res = await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED) + "/resolve",
      headers: { authorization: "Bearer " + token },
      payload: { conflictId, choice: "ours" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses an anonymous caller outright", async () => {
    const { conflictId } = await clash();
    const res = await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(SHARED) + "/resolve",
      payload: { conflictId, choice: "ours" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("an Agent turn writes through CONCORD", () => {
  const runSubtask = (subtaskId: string, token: string, prompt = "do the work") =>
    app.inject({
      method: "POST",
      url: "/api/warrant/subtasks/" + subtaskId + "/run",
      headers: { authorization: "Bearer " + token },
      payload: { prompt },
    });

  it("materializes the committed version, then commits what the turn changed", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    await write(alice.agentId, 0, "# Changelog\n");

    // The "Agent" appends a line to the shared file, as Codex would.
    turn = async (request) => {
      const file = path.join(request.workspacePath, SHARED);
      const before = await readFile(file, "utf8");
      expect(before).toBe("# Changelog\n");
      await writeFile(file, before + "- rate limiter\n", "utf8");
    };

    const res = await runSubtask(alice.id, await login("alice"));
    expect(res.statusCode).toBe(200);
    expect(res.json().reconciled[0]).toMatchObject({ docId: SHARED, status: "written" });
    expect((await read(alice.agentId)).json().content).toBe("# Changelog\n- rate limiter\n");
  });

  it("merges two Agents whose turns overlapped on the same shared file", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    const bob = subtasks[1] as Planned;
    await write(alice.agentId, 0, "# Changelog\n- TBD\n");

    // Both turns must be in flight at once for this to be a race at all. Run
    // them one after the other and the second simply materializes the first's
    // committed version - correct, but it proves nothing about concurrency.
    let arrived = 0;
    let release = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });

    turn = async (request) => {
      const file = path.join(request.workspacePath, SHARED);
      const before = await readFile(file, "utf8");
      if (++arrived === 2) release();
      await bothStarted;

      const mine = request.agentId === alice.agentId;
      await writeFile(
        file,
        mine
          ? before.replace("- TBD", "- rate limiter\n- TBD")
          : before.replace("- TBD", "- TBD\n- config validation"),
        "utf8",
      );
    };

    const [first, second] = await Promise.all([
      runSubtask(alice.id, await login("alice")),
      runSubtask(bob.id, await login("bob")),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Whichever commits first is `written` and the other rebases onto it. Which
    // one wins the race is not the point; that neither is lost is.
    const outcomes = [first, second].map((r) => r.json().reconciled[0].status).sort();
    expect(outcomes).toEqual(["merged", "written"]);

    const content = (await read(alice.agentId)).json().content as string;
    expect(content).toContain("rate limiter");
    expect(content).toContain("config validation");
  });

  it("refuses to run an Agent for a human who does not own it", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;

    let ran = false;
    turn = async () => {
      ran = true;
    };

    const res = await runSubtask(alice.id, await login("bob"));
    expect(res.statusCode).toBe(403);
    // The denial is upstream of the runtime: no container, not a denied one.
    expect(ran).toBe(false);
  });

  it("still commits the edits a failed turn had already made", async () => {
    const subtasks = await planShared();
    const alice = subtasks[0] as Planned;
    await write(alice.agentId, 0, "# Changelog\n");

    turn = async (request) => {
      await writeFile(
        path.join(request.workspacePath, SHARED),
        "# Changelog\n- half-finished\n",
        "utf8",
      );
      throw new Error("runtime exploded");
    };

    const res = await runSubtask(alice.id, await login("alice"));
    expect(res.statusCode).toBe(502);
    expect(res.json().reconciled[0].status).toBe("written");
    expect((await read(alice.agentId)).json().content).toContain("half-finished");
  });
});
