/**
 * The three things CONCORD could not previously claim: that documents survive a
 * restart, that you can see who is on one right now, and that an Agent's own
 * file writes go through it rather than around it.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { keepBoth, SharedDocStore, PRESENCE_TTL_MS, type AuthzCheck } from "./store.js";
import { WorkspaceReconciler } from "./reconcile.js";

const allowAll: AuthzCheck = (agentId) => ({
  allowed: true,
  ruleId: "test.allow",
  reason: "test",
  humanId: "human:" + agentId,
});

const denyOne =
  (blocked: string): AuthzCheck =>
  (agentId) =>
    agentId === blocked
      ? {
          allowed: false,
          ruleId: "WB-6.cross-owner",
          reason: "Warrant does not cover this resource",
          humanId: null,
        }
      : { allowed: true, ruleId: "test.allow", reason: "test", humanId: "human:" + agentId };

const DOC = "docs/CHANGELOG.md";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "concord-runtime-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

describe("documents survive a restart", () => {
  it("reloads content, versions and history from disk", async () => {
    const file = path.join(dir, "concord-docs.json");
    const first = new SharedDocStore(allowAll, Date.now, { persistPath: file });
    await first.initialize();
    await first.write(DOC, "alice_agent", 0, "one\n");
    await first.write(DOC, "alice_agent", 1, "one\ntwo\n");

    // A different process, same file.
    const second = new SharedDocStore(allowAll, Date.now, { persistPath: file });
    await second.initialize();

    const doc = second.snapshot(DOC);
    expect(doc?.version).toBe(2);
    expect(doc?.content).toBe("one\ntwo\n");
    expect(doc?.history).toHaveLength(2);
  });

  it("keeps a rebase possible across the restart", async () => {
    const file = path.join(dir, "concord-docs.json");
    const first = new SharedDocStore(allowAll, Date.now, { persistPath: file });
    await first.initialize();
    await first.write(DOC, "alice_agent", 0, "a\nb\nc\n");
    await first.read(DOC, "bob_agent");

    // The base Bob read is persisted too, so his stale write is still merged
    // rather than demoted to a blind write that can only conflict.
    const second = new SharedDocStore(allowAll, Date.now, { persistPath: file });
    await second.initialize();
    await second.write(DOC, "alice_agent", 1, "a-changed\nb\nc\n");

    const outcome = await second.write(DOC, "bob_agent", 1, "a\nb\nc-changed\n");
    expect(outcome.status).toBe("merged");
    expect(second.snapshot(DOC)?.content).toBe("a-changed\nb\nc-changed\n");
  });

  it("does not restore a lease held by a process that is gone", async () => {
    const file = path.join(dir, "concord-docs.json");
    const first = new SharedDocStore(allowAll, Date.now, { persistPath: file });
    await first.initialize();
    await first.write(DOC, "alice_agent", 0, "x");
    await first.acquireLease(DOC, "alice_agent", 600_000);

    const second = new SharedDocStore(allowAll, Date.now, { persistPath: file });
    await second.initialize();
    expect(second.snapshot(DOC)?.lease).toBeNull();
    // A ten-minute lease from a dead process must not outlive the process.
    expect((await second.write(DOC, "bob_agent", 1, "y")).status).toBe("written");
  });

  it("starts empty when there is no file yet", async () => {
    const store = new SharedDocStore(allowAll, Date.now, {
      persistPath: path.join(dir, "nested", "concord-docs.json"),
    });
    await expect(store.initialize()).resolves.toBeUndefined();
    expect(store.list("alice_agent")).toEqual([]);
  });
});

describe("presence", () => {
  it("shows who is on a document and what they are doing", async () => {
    let clock = 1_000_000;
    const store = new SharedDocStore(allowAll, () => clock);
    await store.read(DOC, "bob_agent");
    await store.write(DOC, "alice_agent", 0, "hello");

    const result = store.presenceOf(DOC, "alice_agent");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const byAgent = Object.fromEntries(result.present.map((p) => [p.agentId, p.activity]));
    expect(byAgent["alice_agent"]).toBe("editing");
    expect(byAgent["bob_agent"]).toBe("viewing");
  });

  it("forgets an Agent that has gone quiet", async () => {
    let clock = 1_000_000;
    const store = new SharedDocStore(allowAll, () => clock);
    await store.read(DOC, "bob_agent");

    clock += PRESENCE_TTL_MS + 1;
    const result = store.presenceOf(DOC, "alice_agent");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.present.map((p) => p.agentId)).toEqual(["alice_agent"]);
  });

  it("is gated by read authority like the content it describes", () => {
    const store = new SharedDocStore(denyOne("intruder_agent"));
    store.seed(DOC, "x");
    expect(store.presenceOf(DOC, "intruder_agent").status).toBe("denied");
  });
});

describe("conflicts are kept until a human settles them", () => {
  const sameLineConflict = async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, "a\nb\nc\n");
    await store.read(DOC, "alice_agent");
    await store.read(DOC, "bob_agent");
    await store.write(DOC, "alice_agent", 1, "a\nALICE\nc\n");
    const losing = await store.write(DOC, "bob_agent", 1, "a\nBOB\nc\n");
    if (losing.status !== "conflict") throw new Error("expected a conflict");
    return { store, conflictId: losing.conflictId };
  };

  it("holds both sides rather than dropping the losing edit", async () => {
    const { store } = await sameLineConflict();
    const open = store.conflictsFor("human:bob_agent", false);
    expect(open).toHaveLength(1);
    expect(open[0]?.ours).toContain("BOB");
    expect(open[0]?.theirs).toContain("ALICE");
  });

  it("lets the owning human choose their own side", async () => {
    const { store, conflictId } = await sameLineConflict();
    const outcome = await store.resolve(DOC, conflictId, "human:bob_agent", false, "a\nBOB\nc\n");
    expect(outcome.status).toBe("resolved");
    expect(store.snapshot(DOC)?.content).toBe("a\nBOB\nc\n");
    expect(store.snapshot(DOC)?.conflicts).toHaveLength(0);
  });

  it("refuses a human settling someone else's conflict", async () => {
    const { store, conflictId } = await sameLineConflict();
    const outcome = await store.resolve(DOC, conflictId, "human:carol", false, "whatever");
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") expect(outcome.ruleId).toBe("WB-6.cross-owner");
    // Nothing moved, and the conflict is still open for its owner.
    expect(store.snapshot(DOC)?.content).toBe("a\nALICE\nc\n");
    expect(store.snapshot(DOC)?.conflicts).toHaveLength(1);
  });

  it("lets the orchestrator settle any conflict", async () => {
    const { store, conflictId } = await sameLineConflict();
    const outcome = await store.resolve(
      DOC,
      conflictId,
      "human:orchestrator",
      true,
      "a\nBOTH\nc\n",
    );
    expect(outcome.status).toBe("resolved");
  });

  it("rebases the resolution rather than overwriting what landed since", async () => {
    const { store, conflictId } = await sameLineConflict();
    // A third edit lands, far from the contested line, while the human decides.
    await store.read(DOC, "carol_agent");
    await store.write(DOC, "carol_agent", 2, "a\nALICE\nc\nCAROL\n");

    const outcome = await store.resolve(DOC, conflictId, "human:bob_agent", false, "a\nBOB\nc\n");
    expect(outcome.status).toBe("resolved");
    // Bob's choice won the contested line; Carol's untouched line survived.
    const content = store.snapshot(DOC)?.content ?? "";
    expect(content).toContain("BOB");
    expect(content).toContain("CAROL");
  });

  it("keeps both sides in place rather than gluing two documents together", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, "# Changelog\n- TBD\n- unrelated\n");
    await store.read(DOC, "alice_agent");
    await store.read(DOC, "bob_agent");
    await store.write(DOC, "alice_agent", 1, "# Changelog\n- rate limiter\n- unrelated\n");
    const losing = await store.write(
      DOC,
      "bob_agent",
      1,
      "# Changelog\n- config validation\n- unrelated\n",
    );
    if (losing.status !== "conflict") throw new Error("expected a conflict");

    const merged = keepBoth(store.snapshot(DOC)?.conflicts[0] ?? { theirs: "", conflicts: [] });
    expect(merged).toBe(
      "# Changelog\n- rate limiter\n- config validation\n- unrelated\n",
    );
    // The agreed lines appear once each; only the contested line is doubled.
    expect(merged.split("\n").filter((l) => l === "# Changelog")).toHaveLength(1);
    expect(merged.split("\n").filter((l) => l === "- unrelated")).toHaveLength(1);
  });

  it("does not resolve a conflict that no longer exists", async () => {
    const store = new SharedDocStore(allowAll);
    expect((await store.resolve(DOC, "cf1_nope", "human:bob", true, "x")).status).toBe(
      "not-found",
    );
  });
});

describe("agents write through CONCORD, not around it", () => {
  const shared = [DOC];

  const workspaceFor = async (name: string) => {
    const workspace = path.join(dir, name);
    await mkdir(workspace, { recursive: true });
    return workspace;
  };

  it("hands the Agent the committed version, then submits what it changed", async () => {
    const store = new SharedDocStore(allowAll);
    const reconciler = new WorkspaceReconciler(store);
    store.seed(DOC, "# Changelog\n");
    const workspace = await workspaceFor("alice");

    const out = await reconciler.materialize(workspace, "alice_agent", shared);
    expect(out[0]?.status).toBe("materialized");
    expect(await readFile(path.join(workspace, DOC), "utf8")).toBe("# Changelog\n");

    // The Agent edits the file in its workspace, exactly as Codex would.
    await writeFile(path.join(workspace, DOC), "# Changelog\n- rate limiter\n", "utf8");

    const results = await reconciler.reconcile(workspace, "alice_agent", shared);
    expect(results[0]?.status).toBe("written");
    expect(store.snapshot(DOC)?.content).toBe("# Changelog\n- rate limiter\n");
  });

  it("merges two Agents that edited the same shared file in one turn window", async () => {
    const store = new SharedDocStore(allowAll);
    const reconciler = new WorkspaceReconciler(store);
    store.seed(DOC, "# Changelog\n- TBD\n");
    const alice = await workspaceFor("alice");
    const bob = await workspaceFor("bob");

    // Both start their turn from version 1.
    await reconciler.materialize(alice, "alice_agent", shared);
    await reconciler.materialize(bob, "bob_agent", shared);

    await writeFile(path.join(alice, DOC), "# Changelog\n- rate limiter\n- TBD\n", "utf8");
    await writeFile(path.join(bob, DOC), "# Changelog\n- TBD\n- config validation\n", "utf8");

    const first = await reconciler.reconcile(alice, "alice_agent", shared);
    const second = await reconciler.reconcile(bob, "bob_agent", shared);

    expect(first[0]?.status).toBe("written");
    expect(second[0]?.status).toBe("merged");

    // Both survived, and Bob's workspace was brought up to the merged text so
    // his next turn does not start from a version nobody agreed on.
    const committed = store.snapshot(DOC)?.content ?? "";
    expect(committed).toContain("rate limiter");
    expect(committed).toContain("config validation");
    expect(await readFile(path.join(bob, DOC), "utf8")).toBe(committed);
  });

  it("reports a same-line clash as a conflict instead of committing it", async () => {
    const store = new SharedDocStore(allowAll);
    const reconciler = new WorkspaceReconciler(store);
    store.seed(DOC, "- TBD\n");
    const alice = await workspaceFor("alice");
    const bob = await workspaceFor("bob");
    await reconciler.materialize(alice, "alice_agent", shared);
    await reconciler.materialize(bob, "bob_agent", shared);

    await writeFile(path.join(alice, DOC), "- rate limiter\n", "utf8");
    await writeFile(path.join(bob, DOC), "- config validation\n", "utf8");

    await reconciler.reconcile(alice, "alice_agent", shared);
    const second = await reconciler.reconcile(bob, "bob_agent", shared);

    expect(second[0]?.status).toBe("conflict");
    expect(second[0]?.conflictId).toBeTruthy();
    expect(store.snapshot(DOC)?.content).toBe("- rate limiter\n");
    expect(store.conflictsFor("human:bob_agent", false)).toHaveLength(1);
  });

  it("does not write when the Agent left the file alone", async () => {
    const store = new SharedDocStore(allowAll);
    const reconciler = new WorkspaceReconciler(store);
    store.seed(DOC, "unchanged\n");
    const workspace = await workspaceFor("alice");

    await reconciler.materialize(workspace, "alice_agent", shared);
    const results = await reconciler.reconcile(workspace, "alice_agent", shared);

    expect(results[0]?.status).toBe("unchanged");
    expect(store.snapshot(DOC)?.version).toBe(1);
  });

  it("refuses a document id that would escape the workspace", async () => {
    const store = new SharedDocStore(allowAll);
    const reconciler = new WorkspaceReconciler(store);
    const workspace = await workspaceFor("alice");

    const escaping = ["../../etc/passwd", "/etc/passwd"];
    const out = await reconciler.materialize(workspace, "alice_agent", escaping);
    expect(out.map((r) => r.status)).toEqual(["denied", "denied"]);
    expect(out[0]?.reason).toContain("escapes the workspace");
  });

  it("does not materialize a document the Agent's warrant does not cover", async () => {
    const store = new SharedDocStore(denyOne("intruder_agent"));
    const reconciler = new WorkspaceReconciler(store);
    const workspace = await workspaceFor("intruder");

    const out = await reconciler.materialize(workspace, "intruder_agent", shared);
    expect(out[0]?.status).toBe("denied");
    // Nothing was written into the workspace, so there is nothing to read.
    await expect(readFile(path.join(workspace, DOC), "utf8")).rejects.toThrow();
  });
});
