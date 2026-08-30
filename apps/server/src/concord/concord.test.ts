import { describe, expect, it } from "vitest";
import { diffLines, merge3, splitLines } from "./merge.js";
import { SharedDocStore, type AuthzCheck } from "./store.js";

const allowAll: AuthzCheck = (agentId) => ({
  allowed: true,
  ruleId: "test.allow",
  reason: "test",
  humanId: "human:" + agentId,
});

/** Everyone but one Agent, which stands in for a warrant that does not cover the doc. */
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

const DOC = "src/limiter.ts";

describe("three-way merge", () => {
  it("converges when two Agents edit disjoint regions", () => {
    const base = "a\nb\nc\nd\ne";
    const ours = "a\nB-CHANGED\nc\nd\ne";
    const theirs = "a\nb\nc\nD-CHANGED\ne";

    const result = merge3(base, ours, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("a\nB-CHANGED\nc\nD-CHANGED\ne");
    }
  });

  it("reports a conflict when both edit the same line", () => {
    const result = merge3("a\nb\nc", "a\nMINE\nc", "a\nYOURS\nc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.ours).toEqual(["MINE"]);
      expect(result.conflicts[0]?.theirs).toEqual(["YOURS"]);
    }
  });

  it("does not invent a conflict when only one side changed", () => {
    expect(merge3("a\nb", "a\nCHANGED", "a\nb")).toMatchObject({
      ok: true,
      content: "a\nCHANGED",
    });
    expect(merge3("a\nb", "a\nb", "a\nCHANGED")).toMatchObject({
      ok: true,
      content: "a\nCHANGED",
    });
  });

  it("accepts identical edits from both sides", () => {
    expect(merge3("a\nb", "a\nSAME", "a\nSAME")).toMatchObject({ ok: true });
  });

  it("merges disjoint insertions at different points", () => {
    const result = merge3("a\nb\nc", "a\nNEW1\nb\nc", "a\nb\nc\nNEW2");
    expect(result.ok).toBe(true);
    if (result.ok) expect(splitLines(result.content)).toContain("NEW1");
    if (result.ok) expect(splitLines(result.content)).toContain("NEW2");
  });

  it("computes hunks in base coordinates", () => {
    const hunks = diffLines(["a", "b", "c"], ["a", "X", "c"]);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ start: 1, deleted: 1, inserted: ["X"] });
  });
});

describe("no lost updates under concurrency", () => {
  it("serialises N concurrent writers and loses nothing", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, "");

    // 20 Agents all read version 1 and then write at once. Without
    // serialisation this is the classic lost-update race.
    const agents = Array.from({ length: 20 }, (_, i) => "agent_" + i);
    await Promise.all(agents.map((a) => store.read(DOC, a)));

    const results = await Promise.all(
      agents.map((a) => store.write(DOC, a, 1, "line from " + a)),
    );

    const accepted = results.filter(
      (r) => r.status === "written" || r.status === "merged",
    );
    const conflicted = results.filter((r) => r.status === "conflict");

    // Every write is accounted for: nothing silently vanished.
    expect(accepted.length + conflicted.length).toBe(agents.length);

    // Exactly one write per accepted operation, and versions are dense.
    const doc = store.snapshot(DOC);
    expect(doc?.version).toBe(1 + accepted.length);
    expect(doc?.history).toHaveLength(accepted.length);

    const versions = doc?.history.map((h) => h.version) ?? [];
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("commits concurrent disjoint edits sequentially, with dense versions", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, "l0\nl1\nl2\nl3\nl4\nl5");

    const agents = ["a0", "a1", "a2"];
    await Promise.all(agents.map((a) => store.read(DOC, a)));

    // Each Agent edits a different line, all from version 1, all at once.
    await Promise.all(
      agents.map((a, i) => {
        const lines = ["l0", "l1", "l2", "l3", "l4", "l5"];
        lines[i * 2] = a.toUpperCase();
        return store.write(DOC, a, 1, lines.join("\n"));
      }),
    );

    const doc = store.snapshot(DOC);
    expect(doc?.version).toBe(4);
    expect(doc?.history.map((h) => h.version)).toEqual([2, 3, 4]);
    // Every Agent's edit survived: serialisation plus merge, not last-write-wins.
    for (const a of agents) expect(doc?.content).toContain(a.toUpperCase());
  });

  it("conflicts rather than clobbers when an Agent writes without reading", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, "base");

    // A blind write has no merge base, so a concurrent one cannot be rebased.
    // Refusing is the safe outcome; silently overwriting is not.
    const [first, second] = await Promise.all([
      store.write(DOC, "blind_1", 1, "one"),
      store.write(DOC, "blind_2", 1, "two"),
    ]);
    const outcomes = [first?.status, second?.status].sort();
    expect(outcomes).toEqual(["conflict", "written"]);
    expect(store.snapshot(DOC)?.version).toBe(2);
  });

  it("rejects a stale write only when it genuinely conflicts", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, "a\nb\nc");

    await store.read(DOC, "alice_agent");
    await store.read(DOC, "bob_agent");

    // Alice edits line 1; Bob edits line 3 from the same base.
    const first = await store.write(DOC, "alice_agent", 1, "a\nALICE\nc");
    expect(first.status).toBe("written");

    const second = await store.write(DOC, "bob_agent", 1, "a\nb\nBOB");
    expect(second.status).toBe("merged");
    if (second.status === "merged") {
      expect(second.content).toBe("a\nALICE\nBOB");
    }
  });

  it("reports a real conflict instead of picking a winner", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, "a\nb\nc");
    await store.read(DOC, "alice_agent");
    await store.read(DOC, "bob_agent");

    await store.write(DOC, "alice_agent", 1, "a\nALICE\nc");
    const clash = await store.write(DOC, "bob_agent", 1, "a\nBOB\nc");

    expect(clash.status).toBe("conflict");
    if (clash.status === "conflict") {
      expect(clash.conflicts[0]?.ours).toEqual(["BOB"]);
      expect(clash.conflicts[0]?.theirs).toEqual(["ALICE"]);
      // Alice's work is still the committed content: nothing was clobbered.
      expect(clash.content).toBe("a\nALICE\nc");
    }
  });
});

describe("leases", () => {
  it("gives one Agent exclusive write access", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, "x");

    const lease = await store.acquireLease(DOC, "alice_agent", 60_000);
    expect(lease.ok).toBe(true);

    const blocked = await store.write(DOC, "bob_agent", 1, "bob was here");
    expect(blocked.status).toBe("leased");
    if (blocked.status === "leased") expect(blocked.holder).toBe("alice_agent");

    // The holder can still write.
    expect((await store.write(DOC, "alice_agent", 1, "alice")).status).toBe("written");
  });

  it("refuses a second lease while one is live", async () => {
    const store = new SharedDocStore(allowAll);
    await store.acquireLease(DOC, "alice_agent", 60_000);
    const second = await store.acquireLease(DOC, "bob_agent", 60_000);
    expect(second.ok).toBe(false);
  });

  it("expires a lease so a dead Agent cannot hold a document forever", async () => {
    let clock = 1_000_000;
    const store = new SharedDocStore(allowAll, () => clock);
    store.seed(DOC, "x");

    await store.acquireLease(DOC, "dead_agent", 5_000);
    expect((await store.write(DOC, "bob_agent", 1, "blocked")).status).toBe("leased");

    clock += 6_000;
    expect((await store.write(DOC, "bob_agent", 1, "now ok")).status).toBe("written");
  });

  it("releases only for the holder", async () => {
    const store = new SharedDocStore(allowAll);
    await store.acquireLease(DOC, "alice_agent", 60_000);
    expect((await store.releaseLease(DOC, "bob_agent")).status).toBe("not-holder");
    expect((await store.releaseLease(DOC, "alice_agent")).status).toBe("released");
  });

  // The negative case for the release path. A holder id is not a secret - the
  // listing shows it - so holder equality alone would let an Agent with no
  // warrant strip someone else's exclusive lease.
  it("denies a release from an Agent with no authority, lease intact", async () => {
    const store = new SharedDocStore(denyOne("intruder_agent"));
    store.seed(DOC, "protected");
    await store.acquireLease(DOC, "alice_agent", 60_000);

    const outcome = await store.releaseLease(DOC, "intruder_agent");
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") expect(outcome.ruleId).toBe("WB-6.cross-owner");

    // Still held: a denied release must not double as a lease breaker.
    expect(store.snapshot(DOC)?.lease?.holder).toBe("alice_agent");
    expect((await store.write(DOC, "bob_agent", 1, "sneak")).status).toBe("leased");
  });
});

describe("read authority scopes what a caller can see", () => {
  it("lists only the documents the caller may read", () => {
    const store = new SharedDocStore((agentId, _action, resource) => ({
      allowed: agentId === "alice_agent" || resource === "repo:shared/CHANGELOG.md",
      ruleId: "test.scope",
      reason: "scoped",
      humanId: "human:" + agentId,
    }));
    store.seed("alice/secret.ts", "alice only");
    store.seed("shared/CHANGELOG.md", "everyone");

    expect(store.list("alice_agent").map((d) => d.id)).toEqual([
      "alice/secret.ts",
      "shared/CHANGELOG.md",
    ]);
    expect(store.list("bob_agent").map((d) => d.id)).toEqual(["shared/CHANGELOG.md"]);
  });

  it("denies history to an Agent the warrant does not cover", () => {
    const store = new SharedDocStore(denyOne("intruder_agent"));
    store.seed(DOC, "base");

    const mine = store.readHistory(DOC, "alice_agent");
    expect(mine.status).toBe("ok");

    // History names the Agent and the human behind every version, so it is
    // gated exactly like the content it describes.
    const theirs = store.readHistory(DOC, "intruder_agent");
    expect(theirs.status).toBe("denied");
  });

  it("answers denied before missing, so it cannot be used to probe for documents", () => {
    const store = new SharedDocStore(denyOne("intruder_agent"));
    expect(store.readHistory("does/not/exist.ts", "intruder_agent").status).toBe("denied");
    expect(store.readHistory("does/not/exist.ts", "alice_agent").status).toBe("missing");
  });
});

describe("authority is checked inside the critical section", () => {
  it("honours a revocation that lands between read and write", async () => {
    let revoked = false;
    const check: AuthzCheck = (agentId) =>
      revoked && agentId === "alice_agent"
        ? {
            allowed: false,
            ruleId: "WB-2.warrant-revoked",
            reason: "Warrant was revoked",
            humanId: "human:alice",
          }
        : { allowed: true, ruleId: "ok", reason: "ok", humanId: "human:alice" };

    const store = new SharedDocStore(check);
    store.seed(DOC, "base");

    expect((await store.read(DOC, "alice_agent")).status).toBe("ok");

    // The owner revokes while the Agent is "thinking".
    revoked = true;

    const write = await store.write(DOC, "alice_agent", 1, "should not land");
    expect(write.status).toBe("denied");
    if (write.status === "denied") {
      expect(write.ruleId).toBe("WB-2.warrant-revoked");
    }
    // The document is untouched.
    expect(store.snapshot(DOC)?.content).toBe("base");
    expect(store.snapshot(DOC)?.version).toBe(1);
  });

  it("denies a read the warrant does not cover", async () => {
    const deny: AuthzCheck = () => ({
      allowed: false,
      ruleId: "WB-6.cross-owner-denied",
      reason: "not yours",
      humanId: "human:bob",
    });
    const store = new SharedDocStore(deny);
    store.seed(DOC, "secret");
    const read = await store.read(DOC, "alice_agent");
    expect(read.status).toBe("denied");
    expect(read.content).toBe("");
  });

  it("attributes every committed version to a human", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, "");
    await store.write(DOC, "alice_agent", 1, "one");
    await store.write(DOC, "bob_agent", 2, "two");

    const history = store.snapshot(DOC)?.history ?? [];
    expect(history.map((h) => h.humanId)).toEqual([
      "human:alice_agent",
      "human:bob_agent",
    ]);
  });
});

describe("independent documents do not block each other", () => {
  it("serialises per document, not globally", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed("a.ts", "");
    store.seed("b.ts", "");

    const results = await Promise.all([
      store.write("a.ts", "agent_1", 1, "A"),
      store.write("b.ts", "agent_2", 1, "B"),
    ]);
    expect(results.every((r) => r.status === "written")).toBe(true);
    expect(store.snapshot("a.ts")?.version).toBe(2);
    expect(store.snapshot("b.ts")?.version).toBe(2);
  });
});
