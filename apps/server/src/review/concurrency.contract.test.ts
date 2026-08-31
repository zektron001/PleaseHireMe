/**
 * CONCORD_REVIEW_LOOP.md, "Parallelism":
 *
 *   "An Agent already running is refused with 409 rather than queued: one
 *   concurrent run per Agent is a hard constraint of both runners."
 *
 *   "The check and the claim happen in the same synchronous step. Claiming
 *   after an await left a window where two runs both passed the check -
 *   found by a test."
 *
 * No such test exists in this repo: consultation.test.ts's "refuses to
 * consult an Agent that is already running" starts the first call, then
 * starts the second only after the first has already suspended at its first
 * `await` - so the second call never actually races the first's claim, it
 * simply observes a claim that already happened. review/reiteration.ts has no
 * dedicated test file at all; runReiteration is only exercised indirectly
 * through review.test.ts (prompt compilation) and http.test.ts (one run at a
 * time over HTTP).
 *
 * This file fires two calls with Promise.allSettled, so both start in the
 * same microtask turn, and lets the language's own evaluation order do the
 * proving: `Promise.allSettled([f(), g()])` evaluates `f()` fully - through
 * every synchronous statement up to its first `await` - before `g()` is even
 * invoked. Because the "already running?" check and the `setState(...,
 * "in_progress")` claim in both runReiteration and ConsultationService.ask
 * are separated by zero `await`s, the first call's claim is guaranteed to
 * land before the second call's check runs. If a future change inserted an
 * await between the check and the claim, this test would start failing
 * (either both admitted, or a flaky result depending on scheduling).
 *
 * CONCORD_REVIEW_LOOP.md, Data model table:
 *
 *   "`Consultation` | `ConsultationService` | in memory (see limitations)"
 *
 * CONCORD_REVIEW_LOOP.md, Limitations:
 *
 *   "Consultations are in memory; comments, runs and events persist."
 *
 * The second half of this file restarts services the way
 * review/persistence.test.ts restarts ReviewService, and checks the asymmetry
 * the doc claims: comments/runs/events (backed by a persistPath) survive: a
 * consultation (ConsultationService has no persistence option at all) does
 * not.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceReconciler } from "../concord/reconcile.js";
import { SharedDocStore, type AuthzCheck } from "../concord/store.js";
import { HttpError } from "../errors.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { ConsultationService } from "./consultation.js";
import { runReiteration } from "./reiteration.js";
import { ReviewService } from "./service.js";

const allowAll: AuthzCheck = (agentId) => ({
  allowed: true,
  ruleId: "test.allow",
  reason: "test",
  humanId: "human:" + agentId,
});

const DOC = "src/limiter.ts";
const BASE = [
  "export function limit(n) {",
  "  if (n < 0) throw new Error('negative');",
  "  return n * 2;",
  "}",
].join("\n");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Stands in for WarrantPlane: just enough surface for reiteration/consultation. */
function fakePlane(workspacePath: string) {
  const subtask = { id: "subtask-1", state: "assigned" as string };
  return {
    orchestrator: {
      subtaskByAgent: (agentId: string) => (agentId === "agent-a" ? subtask : null),
      setState: (_id: string, state: string) => {
        subtask.state = state;
      },
    },
    binder: {
      bind: (_agentId: string, prompt: string) => ({
        request: { agentId: "agent-a", workspacePath, prompt, threadId: null },
      }),
    },
    record: () => undefined,
  } as never;
}

class ScriptedRunner implements AgentRunner {
  constructor(private readonly behaviour: (r: RunnerRequest) => Promise<RunnerResult>) {}
  run(request: RunnerRequest): Promise<RunnerResult> {
    return this.behaviour(request);
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

async function seededStore(): Promise<SharedDocStore> {
  const store = new SharedDocStore(allowAll);
  store.seed(DOC, BASE);
  await store.read(DOC, "agent-a");
  await store.write(DOC, "agent-a", 1, BASE.replace("negative", "negative input"), {
    message: "clarify",
  });
  return store;
}

describe("one concurrent run per Agent - checked and claimed in one synchronous step", () => {
  it("admits exactly one of two concurrent runReiteration calls for the same Agent", async () => {
    const ws = await mkdtemp(path.join(tmpdir(), "concurrency-run-"));
    dirs.push(ws);
    const store = await seededStore();
    const review = new ReviewService(store);
    const commentA = review.createComment({
      docId: DOC, startLine: 2, endLine: 2, body: "one", humanId: "human:alice",
    });
    const commentB = review.createComment({
      docId: DOC, startLine: 2, endLine: 2, body: "two", humanId: "human:alice",
    });
    const reconciler = new WorkspaceReconciler(store);
    const runner = new ScriptedRunner(async () => ({
      output: "revised", threadId: null, usage: null,
    }));
    const deps = {
      plane: fakePlane(ws),
      docs: store,
      reconciler,
      review,
      runner,
    } as never as Parameters<typeof runReiteration>[0];

    // Fired together, not one-then-the-other: both calls start in the same
    // microtask turn, which is the scenario the doc says a naive
    // check-then-await-then-claim would lose.
    const [first, second] = await Promise.allSettled([
      runReiteration(deps, DOC, "agent-a", "human:alice", [commentA]),
      runReiteration(deps, DOC, "agent-a", "human:alice", [commentB]),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.reason).toBeInstanceOf(HttpError);
      expect((second.reason as HttpError).statusCode).toBe(409);
      expect(String((second.reason as HttpError).message)).toMatch(/already running/i);
    }
    if (first.status === "fulfilled") {
      expect(["written", "merged", "conflict", "no_change", "failed"]).toContain(
        first.value.status,
      );
    }
  });

  it("admits exactly one of two concurrent ConsultationService.ask calls for the same Agent", async () => {
    const ws = await mkdtemp(path.join(tmpdir(), "concurrency-consult-"));
    dirs.push(ws);
    const store = await seededStore();
    const reconciler = new WorkspaceReconciler(store);
    const runner = new ScriptedRunner(async () => ({
      output: "it guards the input", threadId: null, usage: null,
    }));
    const service = new ConsultationService(fakePlane(ws), store, reconciler, runner);

    const ask = (question: string) =>
      service.ask({
        docId: DOC,
        agentId: "agent-a",
        humanId: "human:alice",
        startLine: 2,
        endLine: 2,
        question,
      });

    const [first, second] = await Promise.allSettled([ask("one"), ask("two")]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.reason).toBeInstanceOf(HttpError);
      expect((second.reason as HttpError).statusCode).toBe(409);
      expect(String((second.reason as HttpError).message)).toMatch(/already running/i);
    }
    if (first.status === "fulfilled") {
      expect(first.value.status).toBe("completed");
    }
  });
});

describe("consultations are in memory only; comments, runs and events persist", () => {
  it("loses a consultation across a restart while review state survives", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "concurrency-restart-"));
    dirs.push(dataDir);
    const ws = await mkdtemp(path.join(tmpdir(), "concurrency-restart-ws-"));
    dirs.push(ws);
    const file = path.join(dataDir, "review-state.json");

    const store = await seededStore();
    const reconciler = new WorkspaceReconciler(store);
    const runner = new ScriptedRunner(async () => ({
      output: "it guards the input", threadId: null, usage: null,
    }));

    // Comments, runs and events: backed by a persistPath, the same idiom
    // review/persistence.test.ts uses to prove review state survives a restart.
    const reviewFirst = new ReviewService(store, Date.now, { persistPath: file });
    await reviewFirst.initialize();
    const comment = reviewFirst.createComment({
      docId: DOC, startLine: 2, endLine: 2, body: "tighten", humanId: "human:alice",
    });
    const run = reviewFirst.openRun(DOC, "agent-a", "human:alice", [comment], 2);
    reviewFirst.closeRun(run.id, "written", 3, null);
    await reviewFirst.flush();

    // A consultation: ConsultationService has no persistPath option at all.
    const consultFirst = new ConsultationService(fakePlane(ws), store, reconciler, runner);
    const consultation = await consultFirst.ask({
      docId: DOC, agentId: "agent-a", humanId: "human:alice",
      startLine: 2, endLine: 2, question: "Why is this here?",
    });
    expect(consultation.status).toBe("completed");

    // "Restart": fresh service instances over the same durable store and file.
    const reviewSecond = new ReviewService(store, Date.now, { persistPath: file });
    await reviewSecond.initialize();
    const consultSecond = new ConsultationService(fakePlane(ws), store, reconciler, runner);

    expect(reviewSecond.get(comment.id).status).toBe("addressed");
    expect(reviewSecond.listRuns(DOC)).toHaveLength(1);
    expect(reviewSecond.listEvents(DOC).length).toBeGreaterThan(0);

    // The consultation left no trace anywhere a restart could recover it.
    expect(consultSecond.list(DOC)).toHaveLength(0);
    expect(() => consultSecond.get(consultation.id)).toThrow(/not found/i);
  });
});
