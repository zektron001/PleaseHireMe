/**
 * CONCORD_REVIEW_LOOP.md, "Outcomes":
 *
 * | CONCORD | Run | Comments become |
 * | --- | --- | --- |
 * | `written` / `merged` | same | `addressed` |
 * | `conflict` | `conflict` | `conflict`, canonical kept |
 * | `denied` | `denied` | stay `open` |
 * | `leased` | `leased` | stay `open` |
 * | unchanged | `no_change` | stay `open` |
 *
 * One test per row: drive ReviewService.closeRun with the run's status and
 * assert the comment status the doc promises. ReviewService.closeRun computes
 * the comment status with:
 *
 *   status === "written" || status === "merged" ? "addressed"
 *     : status === "conflict" ? "conflict"
 *     : status === "no_change" ? "open"
 *     : "failed"
 *
 * That default arm catches every ReiterationStatus not named on its left -
 * which includes "denied" and "leased", not just genuine failures. The doc
 * says those two stay `open`; the code puts them at `failed`. Verified against
 * apps/server/src/review/service.ts:443-450 before writing this file.
 */

import { describe, expect, it } from "vitest";
import { SharedDocStore, type AuthzCheck } from "../concord/store.js";
import { ReviewService } from "./service.js";
import type { ReviewComment } from "./types.js";

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

async function seeded(): Promise<{ store: SharedDocStore; review: ReviewService }> {
  const store = new SharedDocStore(allowAll);
  store.seed(DOC, BASE);
  await store.read(DOC, "agent-a");
  await store.write(
    DOC,
    "agent-a",
    1,
    BASE.replace("negative", "negative input"),
  );
  return { store, review: new ReviewService(store) };
}

/** Opens a fresh run on one comment, ready to be closed with a given status. */
async function runOnOneComment(): Promise<{ review: ReviewService; comment: ReviewComment; runId: string }> {
  const { review } = await seeded();
  const comment = review.createComment({
    docId: DOC,
    startLine: 2,
    endLine: 2,
    body: "tighten this",
    humanId: "human:alice",
  });
  const run = review.openRun(DOC, "agent-a", "human:alice", [comment], 2);
  return { review, comment, runId: run.id };
}

describe("review outcomes match the documented CONCORD -> comment status table", () => {
  it("written -> comment becomes addressed", async () => {
    const { review, comment, runId } = await runOnOneComment();
    const run = review.closeRun(runId, "written", 3, null);
    expect(run.status).toBe("written");
    expect(review.get(comment.id).status).toBe("addressed");
  });

  it("merged -> comment becomes addressed", async () => {
    const { review, comment, runId } = await runOnOneComment();
    const run = review.closeRun(runId, "merged", 4, null);
    expect(run.status).toBe("merged");
    expect(review.get(comment.id).status).toBe("addressed");
  });

  it("conflict -> comment becomes conflict, canonical kept", async () => {
    const { review, comment, runId } = await runOnOneComment();
    const run = review.closeRun(runId, "conflict", 2, "contested lines");
    expect(run.status).toBe("conflict");
    expect(review.get(comment.id).status).toBe("conflict");
  });

  it("unchanged (no_change) -> comment stays open", async () => {
    const { review, comment, runId } = await runOnOneComment();
    const run = review.closeRun(runId, "no_change", null, null);
    expect(run.status).toBe("no_change");
    expect(review.get(comment.id).status).toBe("open");
  });

  it("denied -> comment stays open, per \"`denied` | `denied` | stay `open`\"", async () => {
    const { review, comment, runId } = await runOnOneComment();
    const run = review.closeRun(runId, "denied", null, "warrant revoked");
    expect(run.status).toBe("denied");
    // REAL FINDING: service.ts's default arm puts this at "failed", not "open".
    expect(review.get(comment.id).status).toBe("open");
  });

  it("leased -> comment stays open, per \"`leased` | `leased` | stay `open`\"", async () => {
    const { review, comment, runId } = await runOnOneComment();
    const run = review.closeRun(runId, "leased", null, "held by another Agent");
    expect(run.status).toBe("leased");
    // REAL FINDING: service.ts's default arm puts this at "failed", not "open".
    expect(review.get(comment.id).status).toBe("open");
  });
});
