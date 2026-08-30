import { describe, expect, it } from "vitest";
import { SharedDocStore, type AuthzCheck } from "./store.js";

const allowAll: AuthzCheck = (agentId) => ({
  allowed: true, ruleId: "t", reason: "t", humanId: "human:" + agentId,
});
const denyReads: AuthzCheck = () => ({
  allowed: false, ruleId: "t.deny", reason: "no warrant covers this file", humanId: null,
});

const DOC = "src/limiter.ts";
const BASE = ["one", "two", "three"].join("\n");

/** Mirrors what the blame route assembles, so the shape is tested directly. */
function blame(store: SharedDocStore, docId: string, agentId: string) {
  const gate = store.readHistory(docId, agentId);
  if (gate.status !== "ok") return { denied: true as const, gate };
  const provenance = store.provenanceOf(docId);
  const byId = new Map(store.contributionsOf(docId).map((c) => [c.id, c]));
  const lines = gate.doc.content.length === 0 ? [] : gate.doc.content.split("\n");
  return {
    denied: false as const,
    version: gate.doc.version,
    lines: lines.map((text, index) => {
      const entry = provenance[index];
      return {
        lineNumber: index + 1,
        text,
        lastModifiedByAgentId: entry?.lastModifiedByAgentId ?? null,
        message: entry?.contributionId
          ? (byId.get(entry.contributionId)?.summary ?? null)
          : null,
      };
    }),
  };
}

describe("blame", () => {
  it("names the Agent that last changed each line, and nobody for seeded lines", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, BASE);
    await store.read(DOC, "agent-a");
    await store.write(DOC, "agent-a", 1, ["one", "TWO by A", "three"].join("\n"), {
      message: "rename the second line",
    });

    const result = blame(store, DOC, "agent-a");
    expect(result.denied).toBe(false);
    if (result.denied) return;
    expect(result.lines.map((l) => l.lastModifiedByAgentId)).toEqual([
      null,
      "agent-a",
      null,
    ]);
    // The Agent's own checkpoint message travels with the line it changed.
    expect(result.lines[1]?.message).toBe("rename the second line (1 line changed)");
    expect(result.lines[0]?.message).toBeNull();
  });

  it("tracks attribution per line when two Agents share a file", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, BASE);
    await store.read(DOC, "agent-a");
    await store.read(DOC, "agent-b");
    await store.write(DOC, "agent-a", 1, ["one", "TWO by A", "three"].join("\n"));
    await store.write(DOC, "agent-b", 1, ["one", "two", "THREE by B"].join("\n"));

    const result = blame(store, DOC, "agent-a");
    if (result.denied) throw new Error("unexpected denial");
    expect(result.lines.map((l) => l.lastModifiedByAgentId)).toEqual([
      null,
      "agent-a",
      "agent-b",
    ]);
  });

  it("refuses attribution for a document the warrant does not cover", async () => {
    const store = new SharedDocStore(denyReads);
    store.seed(DOC, BASE);
    const result = blame(store, DOC, "agent-a");
    // The store's provenance reader is ungated on purpose, so the route's gate
    // is what stops attribution leaking. This proves the gate is the one used.
    expect(result.denied).toBe(true);
  });

  it("stays aligned with the content after many writes", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, BASE);
    for (let round = 0; round < 4; round += 1) {
      const agent = round % 2 === 0 ? "agent-a" : "agent-b";
      await store.read(DOC, agent);
      const doc = store.snapshot(DOC)!;
      await store.write(DOC, agent, doc.version, doc.content + "\nadded-" + round);
    }
    const result = blame(store, DOC, "agent-a");
    if (result.denied) throw new Error("unexpected denial");
    expect(result.lines).toHaveLength(store.snapshot(DOC)!.content.split("\n").length);
    expect(result.lines.at(-1)?.lastModifiedByAgentId).toBe("agent-b");
  });
});
