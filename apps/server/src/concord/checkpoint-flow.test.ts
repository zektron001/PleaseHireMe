import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCheckpoint } from "./checkpoint.js";
import { WorkspaceReconciler } from "./reconcile.js";
import { SharedDocStore, type AuthzCheck } from "./store.js";

const allowAll: AuthzCheck = (agentId) => ({
  allowed: true,
  ruleId: "test.allow",
  reason: "test",
  humanId: "human:" + agentId,
});

const DOC = "src/limiter.ts";
const BASE = ["export function limit() {", "  return 1;", "}"].join("\n");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "checkpoint-"));
  dirs.push(dir);
  return dir;
}

describe("Agent checkpoint commits, end to end through the reconciler", () => {
  it("records the Agent's own message against the version it committed", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, BASE);
    const reconciler = new WorkspaceReconciler(store);
    const ws = await workspace();

    await reconciler.materialize(ws, "agent-a", [DOC]);
    await writeFile(
      path.join(ws, DOC),
      ["export function limit() {", "  return 42;", "}"].join("\n"),
      "utf8",
    );

    // What the Agent actually said at the end of its turn.
    const reply = "Raised the ceiling.\nCONCORD-COMMIT: raise the default limit to 42";
    const results = await reconciler.reconcile(ws, "agent-a", [DOC], {
      message: parseCheckpoint(reply),
      runId: "subtask-9",
    });

    expect(results[0]?.status).toBe("written");
    const entry = store.snapshot(DOC)?.history.at(-1);
    expect(entry?.message).toBe("raise the default limit to 42");
    expect(entry?.agentId).toBe("agent-a");

    const log = store.contributionsOf(DOC);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      agentId: "agent-a",
      runId: "subtask-9",
      outcome: "written",
      baseVersion: 1,
      resultingVersion: 2,
    });
    expect(log[0]?.summary).toBe("raise the default limit to 42 (1 line changed)");
    // And the line the Agent changed is attributed to it.
    expect(store.provenanceOf(DOC)[1]?.lastModifiedByAgentId).toBe("agent-a");
  });

  it("commits without a message when the Agent declared none", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, BASE);
    const reconciler = new WorkspaceReconciler(store);
    const ws = await workspace();
    await reconciler.materialize(ws, "agent-a", [DOC]);
    await writeFile(path.join(ws, DOC), BASE + "\n// tail", "utf8");

    await reconciler.reconcile(ws, "agent-a", [DOC], {
      message: parseCheckpoint("I made a small edit."),
      runId: "subtask-1",
    });

    const entry = store.snapshot(DOC)?.history.at(-1);
    expect(entry?.message).toBeUndefined();
    // The change is still attributed and still counted.
    expect(store.contributionsOf(DOC)[0]?.summary).toBe("1 line changed");
  });

  it("keeps each Agent's checkpoint when two turns land on one file", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, BASE);
    const reconciler = new WorkspaceReconciler(store);
    const wsA = await workspace();
    const wsB = await workspace();

    // Both Agents check the file out at version 1.
    await reconciler.materialize(wsA, "agent-a", [DOC]);
    await reconciler.materialize(wsB, "agent-b", [DOC]);

    await writeFile(
      path.join(wsA, DOC),
      ["export function limit() {", "  return 42;", "}"].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(wsB, DOC),
      ["// bounds checked", "export function limit() {", "  return 1;", "}"].join("\n"),
      "utf8",
    );

    const first = await reconciler.reconcile(wsA, "agent-a", [DOC], {
      message: "raise the limit",
      runId: "s1",
    });
    const second = await reconciler.reconcile(wsB, "agent-b", [DOC], {
      message: "document the bounds",
      runId: "s2",
    });

    expect(first[0]?.status).toBe("written");
    // B was stale but disjoint, so CONCORD merged rather than rejecting.
    expect(second[0]?.status).toBe("merged");

    const log = store.contributionsOf(DOC);
    expect(log.map((c) => c.agentId)).toEqual(["agent-a", "agent-b"]);
    expect(log.map((c) => c.outcome)).toEqual(["written", "merged"]);
    expect(log[1]?.summary).toBe("document the bounds (1 line changed)");

    // Both Agents' work survives, each line attributed to its author.
    const content = store.snapshot(DOC)?.content ?? "";
    expect(content).toContain("return 42;");
    expect(content).toContain("// bounds checked");
    const owners = store.provenanceOf(DOC).map((l) => l.lastModifiedByAgentId);
    expect(owners).toContain("agent-a");
    expect(owners).toContain("agent-b");

    // The workspace is brought up to what actually landed.
    expect(await readFile(path.join(wsB, DOC), "utf8")).toBe(content);
  });

  it("does not record a contribution when the Agent changed nothing", async () => {
    const store = new SharedDocStore(allowAll);
    store.seed(DOC, BASE);
    const reconciler = new WorkspaceReconciler(store);
    const ws = await workspace();
    await reconciler.materialize(ws, "agent-a", [DOC]);

    const results = await reconciler.reconcile(ws, "agent-a", [DOC], {
      message: "claimed a change it did not make",
      runId: "s1",
    });

    expect(results[0]?.status).toBe("unchanged");
    expect(store.contributionsOf(DOC)).toHaveLength(0);
    expect(store.snapshot(DOC)?.version).toBe(1);
  });
});
