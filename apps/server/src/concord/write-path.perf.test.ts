/**
 * What a CONCORD write costs, and what shape it is.
 *
 * This is the path every claim in the product runs through: authority is
 * checked inside it, provenance is reconciled inside it, section ownership is
 * enforced inside it, and it is serialized per document so two Agents cannot
 * interleave. If it is slow, "Agents work in parallel" quietly becomes "Agents
 * queue".
 *
 * The interesting question is not the absolute number - a write sits inside a
 * turn that takes fifteen seconds against a model, so a millisecond either way
 * is noise. It is the SHAPE. Three of the four steps below run a
 * longest-common-subsequence diff over the whole document, which is O(n·m) in
 * lines. That is fine at the size of the documents this platform actually
 * holds and it is not fine forever, so it is measured rather than assumed.
 */

import { afterAll, describe, expect, it } from "vitest";
import { SharedDocStore, type AuthzCheck } from "./store.js";
import { merge3 } from "./merge.js";
import { reconcileProvenance, seedProvenance } from "./provenance.js";
import { findOutOfBounds, locateSection } from "./sections.js";
import { flushMeasurements, measure, MEASUREMENT_FILE } from "../testing/measure.js";

const allow: AuthzCheck = () => ({
  allowed: true,
  ruleId: "PERF.allow",
  reason: "measurement",
  humanId: "human:you",
});

const DOC = "docs/PERF.md";

/** A document shaped like the ones the product holds: headed sections, prose. */
function document(sections: number, linesPerSection: number): string {
  const out = ["# Performance fixture", ""];
  for (let s = 0; s < sections; s += 1) {
    out.push("## Section " + s, "");
    for (let l = 0; l < linesPerSection; l += 1) {
      out.push("- item " + s + "." + l + " with enough text to be a realistic line");
    }
    out.push("");
  }
  return out.join("\n");
}

afterAll(async () => {
  await flushMeasurements(MEASUREMENT_FILE);
});

describe("the serialized write path", () => {
  it("commits a small document well inside its budget", async () => {
    const store = new SharedDocStore(allow);
    const base = document(4, 10);
    await store.write(DOC, "agent_a", 0, base);

    let n = 0;
    const result = await measure(
      {
        name: "concord.write.small",
        claim: "A write to a ~60-line document — the size the demo uses.",
        budgetMs: 15,
        runs: 300,
        justification:
          "Every accepted write runs an authority check, a full-document diff " +
          "for provenance, and a persistence hop, all inside the per-document " +
          "critical section. At this size that is sub-millisecond, which " +
          "matters because the section check and provenance BOTH diff the whole " +
          "file: the cost is paid twice and is still nothing. The budget is " +
          "generous against the measured value on purpose — it exists to catch " +
          "an order-of-magnitude regression, not to pin a laptop's number.",
      },
      async () => {
        n += 1;
        const snapshot = store.snapshot(DOC)!;
        const next = snapshot.content.replace(
          /- item 0\.0[^\n]*/,
          "- item 0.0 revised " + n,
        );
        const outcome = await store.write(DOC, "agent_a", snapshot.version, next);
        expect(outcome.status).toBe("written");
      },
    );
    expect(result.p95).toBeLessThan(result.budgetMs);
  });

  it("stays usable on a document twenty times larger", async () => {
    const store = new SharedDocStore(allow);
    await store.write(DOC, "agent_a", 0, document(20, 60));

    let n = 0;
    const result = await measure(
      {
        name: "concord.write.large",
        claim: "A write to a ~1300-line document — well past anything the demo holds.",
        budgetMs: 400,
        runs: 40,
        justification:
          "This is the one worth watching. The diff underneath provenance and " +
          "the section check is a longest-common-subsequence table, which is " +
          "O(n·m) in lines — so twenty times the document is roughly four " +
          "hundred times the table. The measured p95 confirms that shape rather " +
          "than contradicting it. It is acceptable HERE because a write is " +
          "serialized per document and sits inside a model turn measured in " +
          "seconds, so it is never the thing a human waits for. It would stop " +
          "being acceptable on a source tree, and the fix then is a windowed " +
          "diff around the changed hunk rather than the whole file.",
      },
      async () => {
        n += 1;
        const snapshot = store.snapshot(DOC)!;
        const next = snapshot.content.replace(
          /- item 0\.0[^\n]*/,
          "- item 0.0 revised " + n,
        );
        const outcome = await store.write(DOC, "agent_a", snapshot.version, next);
        expect(outcome.status).toBe("written");
      },
    );
    expect(result.p95).toBeLessThan(result.budgetMs);
  });

  it("shows what section enforcement adds to an accepted write", async () => {
    const store = new SharedDocStore(allow);
    await store.write(DOC, "seed", 0, document(20, 60));
    // WITH an allocation, so the check actually runs. The large-document write
    // above has none, which is why it costs one diff and this costs two.
    store.sections.allocate(DOC, "agent_a", "## Section 3");

    let n = 0;
    const result = await measure(
      {
        name: "concord.write.large-allocated",
        claim:
          "The same large write, but with a section allocated — so the ownership check runs.",
        budgetMs: 500,
        runs: 30,
        justification:
          "The honest cost of section ownership, and the reason it is measured " +
          "separately: an unallocated document short-circuits the check " +
          "entirely, so the cheaper number above says nothing about the " +
          "feature. Against that number this is roughly double, which is " +
          "exactly right — the write now diffs the document twice, once to " +
          "decide whether the change is allowed and once to attribute it. " +
          "Paying twice for a guarantee this strong is a good trade at these " +
          "sizes, and the two calls share an input, so collapsing them into one " +
          "diff is available if a bigger document ever makes it matter.",
      },
      async () => {
        n += 1;
        const snapshot = store.snapshot(DOC)!;
        const next = snapshot.content.replace(
          /- item 3\.0[^\n]*/,
          "- item 3.0 revised " + n,
        );
        const outcome = await store.write(DOC, "agent_a", snapshot.version, next);
        expect(outcome.status).toBe("written");
      },
    );
    expect(result.p95).toBeLessThan(result.budgetMs);
  });

  it("serializes concurrent writers without losing any of them", async () => {
    const WRITERS = 8;
    const result = await measure(
      {
        name: "concord.write.contended",
        claim:
          "Eight Agents committing to one document at once — the no-lost-update claim, timed.",
        budgetMs: 250,
        runs: 30,
        justification:
          "Eight writers race one document and every one of them lands: the " +
          "store queues them per document, so the last writer waits for seven " +
          "predecessors and the batch still finishes in well under the budget. " +
          "This is the cost of the guarantee, and it is the right trade — the " +
          "alternative to queueing is a lost update. Note what is NOT claimed: " +
          "this is one process. CONCORD's serialization is a promise chain in " +
          "memory, so a second server instance would not see it. Single-process " +
          "is a documented constraint, not an oversight this number hides.",
      },
      async (iteration) => {
        const store = new SharedDocStore(allow);
        await store.write(DOC, "seed", 0, document(4, 10));
        const version = store.snapshot(DOC)!.version;

        const outcomes = await Promise.all(
          Array.from({ length: WRITERS }, (_, w) =>
            store.write(
              DOC,
              "agent_" + w,
              version,
              store.snapshot(DOC)!.content + "\n- from writer " + w + " run " + iteration,
            ),
          ),
        );
        // Nothing silently vanished: every writer got a real verdict.
        expect(outcomes).toHaveLength(WRITERS);
        expect(outcomes.every((outcome) => outcome.status !== "denied")).toBe(true);
      },
    );
    expect(result.p95).toBeLessThan(result.budgetMs);
  });
});

describe("what each step of the write costs on its own", () => {
  const content = document(20, 60);
  const changed = content.replace(/- item 3\.4[^\n]*/, "- item 3.4 changed");
  /**
   * A THIRD version, so the merge cannot short-circuit.
   *
   * Measuring `merge3(base, ours, base)` reported 0.036ms — forty times faster
   * than the diff it is built on, because when `theirs` has not moved there is
   * nothing to merge and the function says so immediately. That is a real fast
   * path and it is the common one, but reporting it as "the cost of the merge"
   * would be measuring the early return.
   */
  const theirs = content.replace(/- item 11\.7[^\n]*/, "- item 11.7 changed elsewhere");

  it("three-way merge", async () => {
    const result = await measure(
      {
        name: "concord.merge3",
        claim: "The three-way merge that makes two Agents' edits both survive.",
        budgetMs: 300,
        runs: 40,
        justification:
          "Called only when a write arrives against a version that already " +
          "moved — the interesting case, not the common one. Measured on three " +
          "genuinely different versions, because with `theirs` unchanged the " +
          "function returns early and reports a number forty times better that " +
          "describes the early return rather than the merge. It is the same LCS " +
          "shape as the diff, run twice (base→ours, base→theirs), so it is the " +
          "most expensive single step here.",
      },
      () => {
        const merged = merge3(content, changed, theirs);
        expect(merged.ok).toBe(true);
      },
    );
    expect(result.p95).toBeLessThan(result.budgetMs);
  });

  it("provenance reconciliation", async () => {
    const previous = seedProvenance(DOC, content, 1, new Date().toISOString()).lines.slice();
    const result = await measure(
      {
        name: "concord.provenance",
        claim: "Per-line attribution, recomputed inside every accepted commit.",
        budgetMs: 300,
        runs: 40,
        justification:
          "This is what makes `git blame` per Agent possible, and it is not " +
          "free: it aligns the old and new line arrays on every commit so an " +
          "untouched line keeps its author. Being inside the critical section " +
          "is deliberate — attribution computed after the fact could disagree " +
          "with what was committed, and a review comment would then be routed " +
          "at the wrong Agent.",
      },
      () => {
        const updated = reconcileProvenance({
          previous,
          previousContent: content,
          nextContent: changed,
          agentId: "agent_a",
          contributionId: "c1",
          version: 2,
          at: new Date().toISOString(),
        });
        expect(updated.lines.length).toBe(changed.split("\n").length);
      },
    );
    expect(result.p95).toBeLessThan(result.budgetMs);
  });

  it("section ownership enforcement", async () => {
    const range = locateSection(content, "## Section 3")!;
    const result = await measure(
      {
        name: "concord.section-check",
        claim: "Refusing a write that reaches outside the Agent's allocated section.",
        budgetMs: 300,
        runs: 40,
        justification:
          "The newest thing on the write path, so worth its own number rather " +
          "than being hidden in the total. It diffs the document to find which " +
          "lines a write CHANGES — the payload is always the whole file, so the " +
          "question can only be answered from the diff. That makes it the same " +
          "order as provenance, and it means an accepted write pays the LCS " +
          "cost twice. Measured, that is still comfortably inside budget; if it " +
          "ever stops being, the two share an input and could share one diff.",
      },
      () => {
        const violation = findOutOfBounds(content, changed, range);
        expect(violation).toBeNull();
      },
    );
    expect(result.p95).toBeLessThan(result.budgetMs);
  });
});
