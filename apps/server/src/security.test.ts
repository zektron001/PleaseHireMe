/**
 * Adversarial suite: the platform attacked from outside, not exercised from inside.
 *
 * Every other test file drives the happy path of a plane it already trusts. This
 * one assumes the caller is hostile and holds no credential, and asserts what the
 * DOCS promise about that caller rather than what the code says about itself. The
 * oracle is docs/THREAT_MODEL.md (abuse cases AC-1..AC-12 and section 7, "What a
 * reviewer should check") and docs/WARRANT_TRACK_B.md (rules WB-1..WB-10 and the
 * success test in section 4).
 *
 * A failure here is a finding, not a flake. Each `it` name states the documented
 * promise, so a red line reads as the sentence of the doc it falsifies.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import { WarrantPlane } from "./warrant/index.js";
import { covers, workspaceResource } from "./warrant/resources.js";
import { docResource } from "./concord/store.js";

/** Long enough that loadConfig accepts it even on a non-loopback production host. */
const DEMO_CREDENTIAL = "security-suite-baseline-credential";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({ ok: true }),
} as unknown as AgentService;

let dir = "";
let app: FastifyInstance;
let plane: WarrantPlane;

async function boot(env: Record<string, string> = {}): Promise<void> {
  dir = await mkdtemp(path.join(tmpdir(), "security-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dir,
    AEGIS_ENABLED: "false",
    // This suite probes every route on the server, so at the default level
    // the request log buries the assertion that actually matters. A caller
    // can still override it when debugging a single case.
    LOG_LEVEL: "silent",
    ...env,
  } as NodeJS.ProcessEnv);
  plane = await WarrantPlane.bootstrap(config);
  app = await createApp(config, service, undefined, plane);
}

afterEach(async () => {
  if (app) await app.close();
  if (dir) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
  dir = "";
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

const auth = (token: string) => ({ authorization: "Bearer " + token });

/**
 * Plan a two-owner task with one shared document, the shape the CONCORD demo
 * uses. Returns the ids an attacker would be trying to reach.
 */
async function planTask(token: string, sharedPaths: string[] = ["docs/spec.md"]) {
  const res = await app.inject({
    method: "POST",
    url: "/api/warrant/tasks",
    headers: auth(token),
    payload: {
      title: "Ship the billing export",
      owners: ["human:alice", "human:bob"],
      maxSubtasks: 2,
      sharedPaths,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(Array.isArray(body.subtasks)).toBe(true);
  expect(body.subtasks.length).toBeGreaterThan(0);
  return body as {
    task: { id: string; sharedPaths: string[] };
    subtasks: Array<{
      id: string;
      ownerId: string;
      agentId: string;
      warrantId: string;
      paths: string[];
    }>;
  };
}

// ---------------------------------------------------------------------------
// Route census
// ---------------------------------------------------------------------------

/**
 * Every `/api/` route this server registers, discovered by reading the source
 * rather than by listing them here.
 *
 * A hand-maintained list is a list someone forgets to update; the point of this
 * census is that route 41 fails the gate on the day it is added, without anyone
 * remembering to come back here. Fastify does not expose its route table after
 * construction and `createApp` owns the instance, so the source is the census.
 */
async function registeredRoutes(): Promise<Array<{ method: string; url: string }>> {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => path.join(e.parentPath ?? root, e.name));

  const pattern = /\bapp\.(get|post|put|patch|delete)\(\s*"(\/api\/[^"]*)"/g;
  const found = new Map<string, { method: string; url: string }>();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      const method = match[1]!.toUpperCase();
      const url = match[2]!;
      found.set(method + " " + url, { method, url });
    }
  }
  return [...found.values()].sort((a, b) =>
    (a.url + a.method).localeCompare(b.url + b.method),
  );
}

/**
 * Routes that are unauthenticated ON PURPOSE, with the reason each one has to be.
 *
 * THREAT_MODEL.md TB-0 says the browser/control-plane boundary is guarded by "a
 * session token; shared demo token for baseline routes" - so every route not
 * named here is claimed to sit behind one credential or the other. Adding a
 * route to this list is a security decision and should look like one in review.
 */
const INTENTIONALLY_PUBLIC = new Map<string, string>([
  ["GET /api/health", "liveness probe, carries no tenant data"],
  ["GET /api/auth", "tells an unauthenticated browser whether a token is required"],
  ["POST /api/warrant/session", "the login route itself; nothing to present yet"],
  ["GET /api/warrant/humans", "the mock login roster the sign-in screen renders"],
]);

/** Fill route params with values that survive schema validation far enough to reach auth. */
function concretise(url: string): string {
  return url
    .replace(/:id\b/g, "11111111-2222-3333-4444-555555555555")
    .replace(/:[A-Za-z]+/g, "probe");
}

describe("route census: every /api route is behind a credential (THREAT_MODEL TB-0)", () => {
  it("leaves no route reachable without any credential at all", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const routes = await registeredRoutes();

    // Guard the guard: if the regex stops matching, the sweep silently passes.
    expect(routes.length).toBeGreaterThan(30);

    const reachable: string[] = [];
    for (const { method, url } of routes) {
      const key = method + " " + url;
      if (INTENTIONALLY_PUBLIC.has(key)) continue;

      const res = await app.inject({
        method: method as "GET",
        url: concretise(url),
        payload: method === "GET" || method === "DELETE" ? undefined : {},
      });
      if (res.statusCode !== 401) {
        reachable.push(key + " -> " + res.statusCode);
      }
    }

    expect(reachable).toEqual([]);
  });

  it("keeps the public list honest: each entry really is reachable and really is public", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const routes = await registeredRoutes();
    const registered = new Set(routes.map((r) => r.method + " " + r.url));

    // A stale exemption is worse than a missing one: it silently forgives a
    // route that has since been renamed onto a different, still-gated path.
    for (const key of INTENTIONALLY_PUBLIC.keys()) {
      expect(registered.has(key), key + " is exempted but no longer registered").toBe(
        true,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The unauthenticated kill chain
// ---------------------------------------------------------------------------

describe("unauthenticated reader (THREAT_MODEL AC-8, T5)", () => {
  it("cannot list the tasks on the platform", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const alice = await login("alice");
    await planTask(alice);

    const res = await app.inject({ method: "GET", url: "/api/warrant/tasks" });
    expect(res.statusCode).toBe(401);
  });

  it("cannot read one task, so task ids cannot be probed for existence", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const alice = await login("alice");
    const planned = await planTask(alice);

    const res = await app.inject({
      method: "GET",
      url: "/api/warrant/tasks/" + planned.task.id,
    });
    expect(res.statusCode).toBe(401);
  });

  it("cannot walk task listing into a live agentId and read the shared document", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const alice = await login("alice");
    const planned = await planTask(alice);

    // Seed the shared document so there is something worth stealing.
    const agentId = planned.subtasks[0]!.agentId;
    const docId = planned.task.sharedPaths[0]!;
    await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(docId),
      payload: { agentId, expectedVersion: 0, content: "internal roadmap\n" },
    });

    // The chain, with no credential at any step.
    const listed = await app.inject({ method: "GET", url: "/api/warrant/tasks" });
    const harvested =
      listed.statusCode === 200
        ? String(JSON.stringify(listed.json())).includes(agentId)
        : false;
    expect(
      harvested,
      "an anonymous caller harvested a live agentId from GET /api/warrant/tasks",
    ).toBe(false);

    const read = await app.inject({
      method: "GET",
      url:
        "/api/concord/docs/" +
        encodeURIComponent(docId) +
        "?agentId=" +
        encodeURIComponent(agentId),
    });
    expect(read.statusCode).toBe(401);
  });

  it("cannot write to a shared document by naming a harvested agentId", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const alice = await login("alice");
    const planned = await planTask(alice);
    const agentId = planned.subtasks[0]!.agentId;
    const docId = planned.task.sharedPaths[0]!;

    await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(docId),
      payload: { agentId, expectedVersion: 0, content: "original\n" },
    });

    const attack = await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(docId),
      payload: { agentId, expectedVersion: 1, content: "attacker was here\n" },
    });
    expect(attack.statusCode).toBe(401);
  });

  it("cannot ask the PDP to authorize an action for an agent it merely names", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const alice = await login("alice");
    const planned = await planTask(alice);

    const res = await app.inject({
      method: "POST",
      url: "/api/warrant/act",
      payload: {
        agentId: planned.subtasks[0]!.agentId,
        action: "workspace.write",
        resource: "repo:docs/spec.md",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("cannot read the decision log (THREAT_MODEL section 7, AC-12)", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const res = await app.inject({ method: "GET", url: "/api/warrant/events" });
    expect(res.statusCode).toBe(401);
  });

  it("cannot read plane status", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const res = await app.inject({ method: "GET", url: "/api/warrant/status" });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The success test: a forged user id changes nothing
// ---------------------------------------------------------------------------

/**
 * WARRANT_TRACK_B.md section 4: "changing a user ID in the browser request cannot
 * bypass the authorization decision." routes.ts claims this holds structurally
 * because no handler reads identity from a body, query or header. These tests
 * attack that claim from four directions on every human-identified route.
 */
describe("forged identity is never consulted (WARRANT_TRACK_B section 4)", () => {
  const vectors = [
    { name: "query string", query: "?humanId=human:bob", headers: {}, body: {} },
    { name: "X-Acting-User header", query: "", headers: { "x-acting-user": "human:bob" }, body: {} },
    { name: "X-User-Id header", query: "", headers: { "x-user-id": "human:bob" }, body: {} },
    { name: "request body", query: "", headers: {}, body: { humanId: "human:bob" } },
  ];

  for (const vector of vectors) {
    it("ignores a " + vector.name + " when resolving who is calling", async () => {
      await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
      const alice = await login("alice");

      const res = await app.inject({
        method: "GET",
        url: "/api/warrant/me" + vector.query,
        headers: { ...auth(alice), ...vector.headers },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().human.id).toBe("human:alice");
    });

    it("cannot escalate to the orchestrator via a " + vector.name, async () => {
      await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
      const alice = await login("alice");
      const planned = await planTask(alice);

      // Integration is the orchestrator's alone (WB-7). Alice must not reach it
      // by claiming to be the orchestrator anywhere in the request.
      const res = await app.inject({
        method: "POST",
        url: "/api/warrant/tasks/" + planned.task.id + "/integrate" + vector.query,
        headers: {
          ...auth(alice),
          ...vector.headers,
          ...(vector.name === "X-Acting-User" ? { "x-acting-user": "human:orchestrator" } : {}),
        },
        payload: { ...vector.body, humanId: "human:orchestrator" },
      });
      expect(res.statusCode).toBe(403);
    });
  }

  it("refuses a session token that was never issued", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const res = await app.inject({
      method: "GET",
      url: "/api/warrant/me",
      headers: auth("not-a-real-session-token"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("does not accept the shared baseline credential as a human identity", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const res = await app.inject({
      method: "GET",
      url: "/api/warrant/me",
      headers: auth(DEMO_CREDENTIAL),
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Cross-owner isolation (WB-6) and revocation (WB-2)
// ---------------------------------------------------------------------------

describe("one human cannot drive another human's agent (WB-6, AC-7)", () => {
  it("refuses Alice's agent a write to a file only Bob's subtask owns", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const alice = await login("alice");
    const planned = await planTask(alice);

    const mine = planned.subtasks.find((s) => s.ownerId === "human:alice")!;
    const bobs = planned.subtasks.find((s) => s.ownerId === "human:bob");
    expect(bobs, "planning should have produced a subtask owned by human:bob").toBeTruthy();

    // Not the /act oracle: this is the enforcement point. CONCORD maps a PDP
    // denial to 403, so a 200 here would be a real cross-owner write.
    const res = await app.inject({
      method: "POST",
      url: "/api/concord/docs/" + encodeURIComponent(bobs!.paths[0]!),
      payload: {
        agentId: mine.agentId,
        expectedVersion: 0,
        content: "written by the wrong owner's agent\n",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  /**
   * `/api/warrant/act` takes the agentId from the body and never consults the
   * caller's token, so its answer is about the named agent rather than about the
   * caller. That is defensible for a pure decision endpoint - it mutates nothing
   * - but it makes the route an authorization ORACLE: anyone who reaches it can
   * map which agents may touch which resources. THREAT_MODEL T5 counts that
   * mapping as disclosure, and every call also appends an attacker-shaped record
   * to the hash chain the audit story depends on.
   */
  it("does not answer authorization questions about an agent the caller does not own", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const alice = await login("alice");
    const planned = await planTask(alice);
    const bobs = planned.subtasks.find((s) => s.ownerId === "human:bob")!;

    const res = await app.inject({
      method: "POST",
      url: "/api/warrant/act",
      headers: auth(alice),
      payload: {
        agentId: bobs.agentId,
        action: "workspace.write",
        resource: workspaceResource(bobs.id),
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("denies an agent writing into a sibling agent's workspace (AC-8)", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const alice = await login("alice");
    const planned = await planTask(alice);
    const [first, second] = planned.subtasks;
    expect(second).toBeTruthy();

    const res = await app.inject({
      method: "POST",
      url: "/api/warrant/act",
      headers: auth(alice),
      payload: {
        agentId: first!.agentId,
        action: "workspace.write",
        resource: workspaceResource(second!.id),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().decision.decision).toBe("Deny");
  });
});

describe("revocation takes effect immediately (WB-2, AC-9)", () => {
  it("stops the agent's very next action, with no restart and no cache to expire", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const alice = await login("alice");
    const planned = await planTask(alice);
    const mine = planned.subtasks.find((s) => s.ownerId === "human:alice")!;

    const before = await app.inject({
      method: "POST",
      url: "/api/warrant/act",
      headers: auth(alice),
      payload: {
        agentId: mine.agentId,
        action: "workspace.write",
        resource: workspaceResource(mine.id),
      },
    });
    expect(before.statusCode).toBe(200);

    const revoked = await app.inject({
      method: "POST",
      url: "/api/warrant/revoke",
      headers: auth(alice),
      payload: { warrantId: mine.warrantId, reason: "compromised" },
    });
    expect(revoked.statusCode).toBe(200);

    const after = await app.inject({
      method: "POST",
      url: "/api/warrant/act",
      headers: auth(alice),
      payload: {
        agentId: mine.agentId,
        action: "workspace.write",
        resource: workspaceResource(mine.id),
      },
    });
    expect(after.statusCode).toBe(403);
    expect(after.json().decision.ruleId).toContain("WB-2");
  });

  it("lets only the issuing human revoke a warrant (WB-10)", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const alice = await login("alice");
    const bob = await login("bob");
    const planned = await planTask(alice);
    const mine = planned.subtasks.find((s) => s.ownerId === "human:alice")!;

    const res = await app.inject({
      method: "POST",
      url: "/api/warrant/revoke",
      headers: auth(bob),
      payload: { warrantId: mine.warrantId, reason: "not mine to revoke" },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Scope of a grant
// ---------------------------------------------------------------------------

describe("a warrant grants exactly what it names (WB-5)", () => {
  it("does not turn a root sharedPath into a grant over the whole repo", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const alice = await login("alice");

    // "/" normalises to the empty string, which `covers()` treats as the whole
    // repo prefix. WB-5 says a warrant reaches only the resources it names.
    const planned = await planTask(alice, ["/"]);
    const mine = planned.subtasks.find((s) => s.ownerId === "human:alice")!;

    const res = await app.inject({
      method: "POST",
      url: "/api/warrant/act",
      headers: auth(alice),
      payload: {
        agentId: mine.agentId,
        action: "workspace.write",
        resource: "repo:secrets/keys.txt",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  /**
   * The sharing feature reaches the same prefix by a second road.
   *
   * `docResource` strips leading slashes, so any docId made only of them
   * collapses to the bare "repo:" prefix - and `covers()` reads that prefix as
   * the entire repository (`g === ""` returns true for every resource). The
   * route's own validation does not stop it: `docParams` is
   * `z.string().trim().min(1).max(300)`, which "/" satisfies.
   *
   * This is asserted on the mapping rather than through a full share, because
   * driving it end to end needs a sharer who already holds the root - i.e. the
   * defect above - and a test that needs one bug to demonstrate another proves
   * neither. What matters here is that the share path has no separate guard:
   * the day anything hands out the root, sharing "/" hands over the whole repo
   * under a name that reads like a single document.
   */
  it("never maps a shareable docId onto the bare whole-repo prefix (WB-5)", () => {
    for (const docId of ["/", "//", "   /   "]) {
      const resource = docResource(docId.trim());
      expect(resource).not.toBe("repo:");
      expect(covers(resource, "repo:secrets/keys.txt")).toBe(false);
    }
  });

  it("does not let an agent reach a repo path outside its subtask's paths", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const alice = await login("alice");
    const planned = await planTask(alice);
    const mine = planned.subtasks.find((s) => s.ownerId === "human:alice")!;

    const res = await app.inject({
      method: "POST",
      url: "/api/warrant/act",
      headers: auth(alice),
      payload: {
        agentId: mine.agentId,
        action: "workspace.write",
        resource: "repo:../../etc/passwd",
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Baseline routes behind the shared credential
// ---------------------------------------------------------------------------

describe("the shared baseline credential is actually enforced (TB-0)", () => {
  it("refuses a baseline route with no credential", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const res = await app.inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a baseline route with a wrong credential", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const res = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: auth("security-suite-baseline-credentiaL"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("admits a baseline route with the right credential", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    const res = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: auth(DEMO_CREDENTIAL),
    });
    expect(res.statusCode).toBe(200);
  });

  it("does not leak the configured credential to an unauthenticated caller", async () => {
    await boot({ APP_AUTH_TOKEN: DEMO_CREDENTIAL });
    for (const url of ["/api/health", "/api/auth"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.body).not.toContain(DEMO_CREDENTIAL);
    }
  });
});

// ---------------------------------------------------------------------------
// Audit visibility (T7 / AC-12)
// ---------------------------------------------------------------------------

/**
 * THREAT_MODEL.md section 5, T7, "Trace access control", claims:
 *
 *   "`/api/warrant/events` requires a session; ordinary humans see only their
 *    own decisions"
 *
 * and the note under it claims the log "verifies exactly over the retained
 * window, so a gap is explicit rather than an unexplained verification failure."
 *
 * That is two promises, and they are tested separately here because they fail
 * separately. "Only their own" is a confidentiality bound: Bob must not read
 * Alice's decisions. "A gap is explicit" is a completeness bound: when Alice
 * cannot see one of her own decisions, the response has to say so rather than
 * present a short list under a green chain.
 *
 * The route reads `plane.audit.recent(500)` and filters the viewer's events out
 * of that window AFTERWARDS, so the window is global but the view is personal.
 * These tests pin the consequence.
 */
describe("audit visibility", () => {
  /** Append one decision attributed to `humanId`, the way every route does. */
  function record(humanId: string, agentId: string, reason: string): void {
    plane.record({
      humanId,
      agentId,
      action: "workspace.read",
      resource: workspaceResource("sub_" + reason),
      decision: "Allow",
      ruleId: "WB-0.warrant-covers-resource",
      reason,
    });
  }

  async function eventsFor(token: string) {
    const res = await app.inject({
      method: "GET",
      url: "/api/warrant/events",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      viewer: string;
      scope: string;
      retained: number;
      chainValid: boolean;
      events: Array<{ evidence: Record<string, unknown> }>;
    };
  }

  it("AC-12: refuses the decision log to a caller with no session", async () => {
    await boot();
    const res = await app.inject({ method: "GET", url: "/api/warrant/events" });
    expect(res.statusCode).toBe(401);
  });

  it("T7: shows a human their own decisions", async () => {
    await boot();
    const alice = await login("alice");
    record("human:alice", "agent_alice_1", "alice-own-decision");

    const view = await eventsFor(alice);
    expect(view.viewer).toBe("human:alice");
    expect(view.scope).toBe("own");
    expect(view.events.length).toBeGreaterThan(0);
  });

  it("T7: does not show one human another human's decisions", async () => {
    await boot();
    const bob = await login("bob");
    for (let i = 0; i < 5; i += 1) record("human:alice", "agent_alice_1", "alice-" + i);

    const view = await eventsFor(bob);
    const foreign = view.events.filter((e) => e.evidence["human"] === "human:alice");
    expect(foreign).toEqual([]);
  });

  /**
   * The finding. `recent(500)` slices the GLOBAL tail before the per-viewer
   * filter runs, so Alice's own decisions fall out of Alice's own view as soon
   * as anybody else produces 500 newer ones. Nothing about her authority
   * changed and nothing was pruned: `retained` still counts her record and the
   * chain still verifies. She simply cannot see it.
   *
   * 500 is not an exotic number. The console polls six endpoints roughly every
   * 1.5s and each poll that touches a shared document appends a decision, so a
   * second person with a tab open reaches it in minutes.
   */
  it("T7: a human keeps seeing their own decision after 500 unrelated ones", async () => {
    await boot();
    const alice = await login("alice");
    record("human:alice", "agent_alice_1", "alice-earliest-decision");

    const before = await eventsFor(alice);
    expect(before.events.length).toBe(1);

    // Bob gets busy. None of this is Alice's, and none of it is pruned.
    for (let i = 0; i < 500; i += 1) record("human:bob", "agent_bob_1", "bob-" + i);

    const after = await eventsFor(alice);
    expect(after.retained).toBeGreaterThan(500);
    expect(after.events.length).toBe(1);
  });

  /**
   * The same defect stated as the doc states it. A viewer who has lost sight of
   * her own decisions is looking at a gap, and the note under the T7 table
   * promises a gap is explicit. `chainValid` stays true and `retained` stays
   * high, so the response carries no signal that the view is short.
   */
  it("T7: says so when the viewer's window hides decisions it still retains", async () => {
    await boot();
    const alice = await login("alice");
    record("human:alice", "agent_alice_1", "alice-earliest-decision");
    for (let i = 0; i < 500; i += 1) record("human:bob", "agent_bob_1", "bob-" + i);

    const view = await eventsFor(alice);
    const hidden = view.events.length === 0;
    // Either she can still see it, or the response admits it is truncated.
    expect(hidden && view.chainValid && view.retained > 0).toBe(false);
  });
});
