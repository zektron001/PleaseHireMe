import { describe, expect, it } from "vitest";
import { SharedDocStore, type AuthzCheck } from "./store.js";

const allowAll: AuthzCheck = (agentId) => ({
  allowed: true,
  ruleId: "test.allow",
  reason: "test",
  humanId: "human:" + agentId,
});

const denyWrites: AuthzCheck = (agentId, action) => ({
  allowed: action !== "workspace.write",
  ruleId: "test.deny-write",
  reason: "no write warrant",
  humanId: "human:" + agentId,
});

const DOC = "src/limiter.ts";
const BASE = ["one", "two", "three", "four", "five"].join("\n");

/** Who last changed each line, 1-based, for readable assertions. */
function owners(store: SharedDocStore, docId = DOC): (string | null)[] {
  return store.provenanceOf(docId).map((line) => line.lastModifiedByAgentId);
}

describe("provenance through the real CONCORD write path", () => {
  it("attributes only the lines an accepted write changed", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, BASE);
    await store.read(DOC, "agent-a");

    const outcome = await store.write(
      DOC,
      "agent-a",
      1,
      ["one", "TWO by A", "three", "four", "five"].join("\n"),
      { message: "tighten the limiter" },
    );

    expect(outcome.status).toBe("written");
    expect(owners(store)).toEqual([null, "agent-a", null, null, null]);
  });

  it("keeps both Agents' attribution when a merge combines their edits", async () => {
    // The version-control case: two Agents commit to one file concurrently
    // from the same base, touching different regions.
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, BASE);
    await store.read(DOC, "agent-a");
    await store.read(DOC, "agent-b");

    const first = await store.write(
      DOC,
      "agent-a",
      1,
      ["one", "TWO by A", "three", "four", "five"].join("\n"),
      { message: "A: rename" },
    );
    expect(first.status).toBe("written");

    // B still believes the document is at version 1: stale, but disjoint.
    const second = await store.write(
      DOC,
      "agent-b",
      1,
      ["one", "two", "three", "FOUR by B", "five"].join("\n"),
      { message: "B: bounds check" },
    );

    expect(second.status).toBe("merged");
    // Neither Agent's work was lost, and each line is attributed to its author.
    expect(owners(store)).toEqual([null, "agent-a", null, "agent-b", null]);
    const doc = store.snapshot(DOC);
    expect(doc?.content).toContain("TWO by A");
    expect(doc?.content).toContain("FOUR by B");
  });

  it("records one contribution per accepted write, with a safe summary", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, BASE);
    await store.read(DOC, "agent-a");
    await store.write(DOC, "agent-a", 1, ["one", "X", "three", "four", "five"].join("\n"), {
      message: "checkpoint: extracted the guard",
      runId: "run-1",
    });

    const log = store.contributionsOf(DOC);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      agentId: "agent-a",
      outcome: "written",
      baseVersion: 1,
      resultingVersion: 2,
      runId: "run-1",
    });
    expect(log[0]?.changedLineIds).toHaveLength(1);
    expect(log[0]?.summary).toBe("checkpoint: extracted the guard (1 line changed)");
  });

  it("carries the Agent's checkpoint message into document history", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, BASE);
    await store.read(DOC, "agent-a");
    await store.write(DOC, "agent-a", 1, BASE + "\nsix", { message: "add six" });

    const entry = store.snapshot(DOC)?.history.at(-1);
    expect(entry?.message).toBe("add six");
    expect(entry?.agentId).toBe("agent-a");
    expect(entry?.contributionId).toBeTruthy();
  });

  it("leaves provenance untouched when a write conflicts", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, BASE);
    await store.read(DOC, "agent-a");
    await store.read(DOC, "agent-b");
    await store.write(DOC, "agent-a", 1, ["one", "A WINS", "three", "four", "five"].join("\n"));
    const before = owners(store);

    const clash = await store.write(
      DOC,
      "agent-b",
      1,
      ["one", "B WANTS", "three", "four", "five"].join("\n"),
    );

    expect(clash.status).toBe("conflict");
    expect(owners(store)).toEqual(before);
    expect(store.contributionsOf(DOC)).toHaveLength(1);
    expect(store.snapshot(DOC)?.content).toContain("A WINS");
  });

  it("leaves provenance untouched when a write is denied", async () => {
    const store = new SharedDocStore(denyWrites);
    store.seed(DOC, BASE);
    const before = owners(store);

    const denied = await store.write(DOC, "agent-a", 1, "rewritten by an unwarranted Agent");

    expect(denied.status).toBe("denied");
    expect(owners(store)).toEqual(before);
    expect(store.contributionsOf(DOC)).toHaveLength(0);
    expect(store.snapshot(DOC)?.content).toBe(BASE);
  });

  it("holds one provenance entry per canonical line after many writes", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, BASE);
    for (let round = 0; round < 5; round += 1) {
      const agent = round % 2 === 0 ? "agent-a" : "agent-b";
      await store.read(DOC, agent);
      const doc = store.snapshot(DOC)!;
      await store.write(DOC, agent, doc.version, doc.content + "\nline-" + round);
    }
    const doc = store.snapshot(DOC)!;
    expect(store.provenanceOf(DOC)).toHaveLength(doc.content.split("\n").length);
  });
  it("attributes lines a human settled to the human, not to either Agent", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, BASE);
    await store.read(DOC, "agent-a");
    await store.read(DOC, "agent-b");
    await store.write(DOC, "agent-a", 1, ["one", "A WINS", "three", "four", "five"].join("\n"));
    const clash = await store.write(
      DOC,
      "agent-b",
      1,
      ["one", "B WANTS", "three", "four", "five"].join("\n"),
    );
    expect(clash.status).toBe("conflict");
    if (clash.status !== "conflict") throw new Error("expected a conflict");

    const resolved = await store.resolve(
      DOC,
      clash.conflictId,
      "human:agent-b",
      false,
      ["one", "HUMAN DECIDED", "three", "four", "five"].join("\n"),
    );

    expect(resolved.status).toBe("resolved");
    // Provenance still has exactly one entry per line, and the settled line is
    // the human's rather than silently still Agent A's.
    expect(store.provenanceOf(DOC)).toHaveLength(5);
    expect(owners(store)[1]).toBe("human:agent-b");
  });
});
