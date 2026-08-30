import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedDocStore, type AuthzCheck } from "../concord/store.js";
import { ReviewService } from "./service.js";

const allowAll: AuthzCheck = (agentId) => ({
  allowed: true, ruleId: "t", reason: "t", humanId: "human:" + agentId,
});

const DOC = "src/limiter.ts";
const BASE = ["one", "two", "three"].join("\n");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function seededStore(): Promise<SharedDocStore> {
  const store = new SharedDocStore(allowAll);
  store.seed(DOC, BASE);
  await store.read(DOC, "agent-a");
  await store.write(DOC, "agent-a", 1, ["one", "TWO by A", "three"].join("\n"), {
    message: "rename",
  });
  return store;
}

describe("review state survives a restart", () => {
  it("restores comments, runs and events from disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "review-persist-"));
    dirs.push(dir);
    const file = path.join(dir, "review-state.json");

    const store = await seededStore();
    const first = new ReviewService(store, Date.now, { persistPath: file });
    await first.initialize();

    const comment = first.createComment({
      docId: DOC,
      startLine: 2,
      endLine: 2,
      body: "Explain this rename.",
      humanId: "human:alice",
    });
    const run = first.openRun(DOC, "agent-a", "human:alice", [comment], 2);
    first.closeRun(run.id, "written", 3, null);
    await first.flush();

    // A fresh process reading the same file.
    const second = new ReviewService(store, Date.now, { persistPath: file });
    await second.initialize();

    const restored = second.get(comment.id);
    expect(restored.body).toBe("Explain this rename.");
    expect(restored.responsibleAgentId).toBe("agent-a");
    expect(restored.selectedTextHash).toBe(comment.selectedTextHash);
    expect(restored.status).toBe("addressed");
    expect(second.listRuns(DOC)).toHaveLength(1);
    expect(second.listEvents(DOC).length).toBeGreaterThan(0);
  });

  it("keeps the event sequence monotonic across a restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "review-persist-"));
    dirs.push(dir);
    const file = path.join(dir, "review-state.json");
    const store = await seededStore();

    const first = new ReviewService(store, Date.now, { persistPath: file });
    await first.initialize();
    first.createComment({
      docId: DOC, startLine: 2, endLine: 2, body: "one", humanId: "human:alice",
    });
    await first.flush();
    const highestBefore = first.listEvents(DOC)[0]?.sequence ?? 0;

    const second = new ReviewService(store, Date.now, { persistPath: file });
    await second.initialize();
    second.createComment({
      docId: DOC, startLine: 2, endLine: 2, body: "two", humanId: "human:alice",
    });
    await second.flush();

    const sequences = second.listEvents(DOC).map((event) => event.sequence);
    expect(Math.max(...sequences)).toBeGreaterThan(highestBefore);
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("starts empty when there is no state file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "review-persist-"));
    dirs.push(dir);
    const store = await seededStore();
    const service = new ReviewService(store, Date.now, {
      persistPath: path.join(dir, "absent.json"),
    });
    await service.initialize();
    expect(service.listComments(DOC)).toHaveLength(0);
  });

  it("rejects an unsupported state format rather than guessing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "review-persist-"));
    dirs.push(dir);
    const file = path.join(dir, "review-state.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify({ version: 99, comments: [] }), "utf8");

    const store = await seededStore();
    const service = new ReviewService(store, Date.now, { persistPath: file });
    await expect(service.initialize()).rejects.toThrow(/Unsupported review state/i);
  });
});
