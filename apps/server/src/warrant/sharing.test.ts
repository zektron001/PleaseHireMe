/**
 * Sharing, over the real HTTP surface.
 *
 * The claim this file has to keep honest is the one the share dialog makes to
 * anyone reading it: a row in that list is an ACL entry between two humans and
 * confers NOTHING until the recipient attaches an Agent of their own, at which
 * point a scoped, expiring, revocable warrant exists and the PDP decides the
 * rest exactly as it always did.
 *
 * So the interesting tests here are the negative ones. A grant with no Agent
 * behind it cannot act. A Viewer cannot re-share, and cannot comment. A
 * Commenter cannot write. Withdrawing a share kills the warrants it minted in
 * the same instant. And the Track B invariant survives sharing: who is sharing
 * comes from the session token, so no request body can make a grant come from
 * somebody else.
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
import type { ShareRole } from "./types.js";

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
const DOC = "/api/concord/docs/" + encodeURIComponent(SHARED);
/** Carol's own Agent. She names it; nobody hands it to her. */
const CAROL_AGENT = "agent-carol-own";

let dir = "";
let app: FastifyInstance;
let plane: WarrantPlane;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sharing-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dir,
    AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
    CODEX_HOME: path.join(dir, "codex-home"),
    AEGIS_ENABLED: "false",
  } as NodeJS.ProcessEnv);
  plane = await WarrantPlane.bootstrap(config);
  plane.registry.addHuman("carol", "Carol Nwosu");
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

/** Alice and Bob get subtask warrants over SHARED. Carol gets nothing. */
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

const share = (token: string, role: ShareRole, granteeId = "human:carol") =>
  app.inject({
    method: "POST",
    url: "/api/share/docs/" + encodeURIComponent(SHARED),
    headers: bearer(token),
    payload: { granteeId, role },
  });

const attach = (token: string, grantId: string, agentId = CAROL_AGENT) =>
  app.inject({
    method: "POST",
    url: "/api/share/grants/" + grantId + "/agent",
    headers: bearer(token),
    payload: { agentId },
  });

const read = (token: string, agentId: string) =>
  app.inject({
    method: "GET",
    url: DOC + "?agentId=" + encodeURIComponent(agentId),
    headers: bearer(token),
  });

const write = (token: string, agentId: string, expectedVersion: number, content: string) =>
  app.inject({
    method: "POST",
    url: DOC,
    headers: bearer(token),
    payload: { agentId, expectedVersion, content },
  });

const comment = (token: string) =>
  app.inject({
    method: "POST",
    url: "/api/review/docs/" + encodeURIComponent(SHARED) + "/comments",
    headers: bearer(token),
    payload: { startLine: 1, endLine: 1, body: "Please cite the RFC here." },
  });

/** Alice shares at `role`, Carol attaches her own Agent. Returns the grant id. */
async function sharedTo(role: ShareRole, seed = false): Promise<string> {
  const subtasks = await plan();
  const alice = await login("alice");
  const carol = await login("carol");
  // A comment names a line range, so anything testing comments needs the
  // document to have lines. Alice's own subtask Agent puts them there.
  if (seed) {
    const mine = subtasks.find((subtask) => subtask.ownerId === "human:alice");
    await write(alice, (mine as Planned).agentId, 0, "First line.\nSecond line.\n");
  }
  const granted = await share(alice, role);
  expect(granted.statusCode).toBe(201);
  const grantId = granted.json().grant.id as string;
  expect((await attach(carol, grantId)).statusCode).toBe(201);
  return grantId;
}

describe("a grant is not authority", () => {
  it("mints nothing until the recipient brings an Agent", async () => {
    await plan();
    const alice = await login("alice");
    const before = plane.registry.listWarrants().length;

    const granted = await share(alice, "editor");
    expect(granted.statusCode).toBe(201);
    expect(granted.json().grant.agents).toEqual([]);
    // The decisive assertion: an ACL row was created and no warrant was.
    expect(plane.registry.listWarrants()).toHaveLength(before);
  });

  it("refuses an Agent the grant has not been attached to", async () => {
    await plan();
    const alice = await login("alice");
    const carol = await login("carol");
    await share(alice, "editor");

    // Carol holds a grant, but her Agent holds no warrant, so the gate in
    // front of the PDP does not even find a delegation to check.
    expect((await read(carol, CAROL_AGENT)).statusCode).toBe(403);
  });

  it("lets the recipient's own Agent read once attached", async () => {
    await sharedTo("editor");
    const carol = await login("carol");

    const seen = await read(carol, CAROL_AGENT);
    expect(seen.statusCode).toBe(200);
    expect(seen.json().resource).toBe("repo:" + SHARED);
  });

  it("issues the warrant to the recipient, delegated by the sharer", async () => {
    await sharedTo("editor");
    const minted = plane.registry
      .listWarrants()
      .find((warrant) => warrant.agentId === CAROL_AGENT);

    expect(minted?.humanId).toBe("human:carol");
    expect(minted?.origin).toBe("share");
    expect(minted?.grantedBy).toBe("human:alice");
    // Scoped to the one document, not to Alice's whole workspace.
    expect(minted?.resources).toEqual(["repo:" + SHARED]);
  });

  it("expires the minted warrant with the grant, never after it", async () => {
    const grantId = await sharedTo("editor");
    const grant = plane.shares.get(grantId);
    const minted = plane.registry
      .listWarrants()
      .find((warrant) => warrant.agentId === CAROL_AGENT);

    expect(minted?.expiresAt).toBe(grant?.expiresAt);
  });
});

describe("roles are enforced, not decorative", () => {
  it("lets an Editor's Agent write", async () => {
    await sharedTo("editor");
    const carol = await login("carol");

    const written = await write(carol, CAROL_AGENT, 0, "First line.\n");
    expect(written.statusCode).toBe(200);
  });

  it("refuses a Commenter's Agent the write", async () => {
    await sharedTo("commenter");
    const carol = await login("carol");

    const written = await write(carol, CAROL_AGENT, 0, "First line.\n");
    expect(written.statusCode).toBe(403);
    expect(written.json().outcome.reason).toMatch(/workspace:write/);
  });

  it("lets a Commenter comment", async () => {
    await sharedTo("commenter", true);
    const carol = await login("carol");
    expect((await comment(carol)).statusCode).toBe(201);
  });

  it("refuses a Viewer the comment", async () => {
    await sharedTo("viewer", true);
    const carol = await login("carol");

    const refused = await comment(carol);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/not comment/);
  });
});

describe("attenuation: you cannot grant what you do not hold", () => {
  it("refuses to let a Viewer re-share", async () => {
    await sharedTo("viewer");
    const carol = await login("carol");

    plane.registry.addHuman("dave", "Dave Osei");
    const refused = await share(carol, "viewer", "human:dave");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/Only someone who can edit/);
  });

  it("tells a Viewer, in the dialog, that they may not share", async () => {
    await sharedTo("viewer");
    const carol = await login("carol");

    const view = await app.inject({
      method: "GET",
      url: "/api/share/docs/" + encodeURIComponent(SHARED),
      headers: bearer(carol),
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().canShare).toBe(false);
    expect(view.json().maxRole).toBeNull();
  });

  it("lets an Editor re-share, but never wider than Editor", async () => {
    await sharedTo("editor");
    const carol = await login("carol");
    plane.registry.addHuman("dave", "Dave Osei");

    const onward = await share(carol, "editor", "human:dave");
    expect(onward.statusCode).toBe(201);
    expect(onward.json().grant.grantedBy).toBe("human:carol");
  });

  it("refuses a share to somebody who does not exist", async () => {
    await plan();
    const alice = await login("alice");
    const refused = await share(alice, "editor", "human:nobody");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/No such person/);
  });

  it("hides the sharing state of a document from a stranger", async () => {
    await plan();
    const carol = await login("carol");
    const refused = await app.inject({
      method: "GET",
      url: "/api/share/docs/" + encodeURIComponent(SHARED),
      headers: bearer(carol),
    });
    expect(refused.statusCode).toBe(403);
  });
});

describe("withdrawing a share", () => {
  it("kills every warrant the grant minted, immediately", async () => {
    const grantId = await sharedTo("editor");
    const alice = await login("alice");
    const carol = await login("carol");
    expect((await read(carol, CAROL_AGENT)).statusCode).toBe(200);

    const revoked = await app.inject({
      method: "POST",
      url: "/api/share/grants/" + grantId + "/revoke",
      headers: bearer(alice),
      payload: { reason: "Sprint over" },
    });
    expect(revoked.statusCode).toBe(200);

    // The next action Carol's Agent tries is refused. Not on the next sweep -
    // now, because the warrant behind it is revoked rather than forgotten.
    expect((await read(carol, CAROL_AGENT)).statusCode).toBe(403);
    const dead = plane.registry
      .listWarrants()
      .find((warrant) => warrant.agentId === CAROL_AGENT);
    expect(dead?.revokedAt).not.toBeNull();
    expect(dead?.revokedReason).toMatch(/Sprint over/);
  });

  it("lets the recipient hand their own access back", async () => {
    const grantId = await sharedTo("editor");
    const carol = await login("carol");

    const handed = await app.inject({
      method: "POST",
      url: "/api/share/grants/" + grantId + "/revoke",
      headers: bearer(carol),
      payload: {},
    });
    expect(handed.statusCode).toBe(200);
    expect((await read(carol, CAROL_AGENT)).statusCode).toBe(403);
  });

  it("refuses a bystander the revocation", async () => {
    const grantId = await sharedTo("editor");
    const bob = await login("bob");

    const refused = await app.inject({
      method: "POST",
      url: "/api/share/grants/" + grantId + "/revoke",
      headers: bearer(bob),
      payload: {},
    });
    expect(refused.statusCode).toBe(403);
  });

  it("revokes the old warrant when a role is narrowed", async () => {
    await sharedTo("editor");
    const alice = await login("alice");
    const carol = await login("carol");

    // Downgrade Carol to Viewer. The Editor warrant underneath must not
    // survive - a permissions UI whose old grant stays live is worse than
    // one that never offered the change.
    const narrowed = await share(alice, "viewer");
    expect(narrowed.statusCode).toBe(201);

    const editorWarrant = plane.registry
      .listWarrants()
      .find((warrant) => warrant.scopes.includes("workspace:write") && warrant.agentId === CAROL_AGENT);
    expect(editorWarrant?.revokedAt).not.toBeNull();

    // And the new grant confers nothing until she re-attaches.
    expect((await read(carol, CAROL_AGENT)).statusCode).toBe(403);
  });
});

describe("the Track B invariant survives sharing", () => {
  it("never reads the sharer from the request body", async () => {
    await plan();
    const carol = await login("carol");

    // Carol holds nothing on this document. She names Alice as the granter
    // in every way a request can carry a name; the server reads none of them.
    const forged = await app.inject({
      method: "POST",
      url: "/api/share/docs/" + encodeURIComponent(SHARED),
      headers: { ...bearer(carol), "x-human-id": "human:alice" },
      payload: {
        granteeId: "human:carol",
        role: "editor",
        grantedBy: "human:alice",
        humanId: "human:alice",
      },
    });

    // Refused as Carol - the self-share rule - rather than accepted as Alice.
    expect(forged.statusCode).toBe(403);
    expect(plane.shares.list()).toHaveLength(0);
  });

  it("refuses to let one human attach an Agent to another's grant", async () => {
    await plan();
    const alice = await login("alice");
    const bob = await login("bob");
    const grantId = (await share(alice, "editor")).json().grant.id as string;

    // Bob attaching HIS Agent to CAROL's grant would be Bob acting on
    // Carol's delegation. Only the grantee may bring the Agent.
    const refused = await attach(bob, grantId, "agent-bob-own");
    expect(refused.statusCode).toBe(403);
    expect(plane.registry.warrantForAgent("agent-bob-own")).toBeNull();
  });

  it("writes both the allow and the refusal into the audit chain", async () => {
    await sharedTo("editor");
    const alice = await login("alice");
    await share(alice, "editor", "human:nobody");

    const chain = plane.audit.recent(500);
    const rules = chain.map((entry) => entry.verdict.ruleId);
    expect(rules).toContain("WB-0.share-within-holdings");
    expect(rules).toContain("WB-0.share-agent-attached");
    expect(rules).toContain("WB-13.share-unknown-grantee");
    expect(plane.audit.verify()).toBe(-1);
  });
});
