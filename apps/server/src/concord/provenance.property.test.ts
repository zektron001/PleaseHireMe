import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { props } from "../testing/fuzz.js";
import { joinLines, merge3, splitLines } from "./merge.js";
import { reconcileProvenance, responsibleAgents, seedProvenance, type LineProvenance } from "./provenance.js";

/**
 * Property suite for the pure line-attribution core (provenance.ts's module
 * doc: "Two features rest on this... Reconciliation reuses CONCORD's
 * existing line diff... a line the Agent did not touch keeps its previous
 * lineId and its previous attribution, so provenance survives other Agents'
 * edits instead of being reset on every write." and reconcileProvenance's
 * own doc: "Lines the diff deletes simply disappear - their provenance is
 * not carried forward onto an unrelated line.").
 *
 * Also anchored on docs/CONCORD_REVIEW_LOOP.md's "provenance algorithm"
 * section (lines 69-82):
 *   "3. Lines outside any hunk keep their `lineId` and their previous
 *    attribution."
 *   "4. Deleted lines drop their provenance; it is never shifted onto a
 *    neighbour, which would misroute a comment."
 *   "5. Inserted or replaced lines get fresh ids attributed to the writing
 *    Agent."
 *   "Invariant, enforced with a throw: `provenance.length ===
 *    lines(content).length`. A misaligned array is how a comment reaches the
 *    wrong Agent, so it fails loudly."
 */

const AT = "2026-08-30T00:00:00.000Z";

/** A single line of content: no "\n" (that's the separator splitLines/
 * joinLines use), otherwise arbitrary — including the empty string, which is
 * exactly the value whose encoding is at the centre of the findings below. */
const lineArb = fc.string({ maxLength: 12 }).filter((s) => !s.includes("\n"));

function mkArbitraryProvenance(n: number): LineProvenance[] {
  return Array.from({ length: n }, (_, i) => ({
    lineId: "arbitrary-" + i,
    lastModifiedByAgentId: null,
    contributionId: null,
    resultingDocumentVersion: 1,
    updatedAt: AT,
  }));
}

describe("seedProvenance", () => {
  /** "Provenance for content that exists before any Agent has written to
   * it" — one entry per line, every one attributed to nobody. */
  it("produces exactly one entry per line, each attributed to null", () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 30 }), (lines) => {
        const content = joinLines(lines);
        const seeded = seedProvenance("doc", content, 1, AT);
        expect(seeded.lines).toHaveLength(splitLines(content).length);
        expect(seeded.lines.every((l) => l.lastModifiedByAgentId === null)).toBe(true);
        expect(seeded.lines.every((l) => l.contributionId === null)).toBe(true);
      }),
      props(4000),
    );
  });
});

describe("reconcileProvenance's length invariant", () => {
  /**
   * "Invariant, enforced with a throw: `provenance.length ===
   * lines(content).length`." Either outcome — a correctly-sized array, or a
   * thrown Error — satisfies the invariant; a misaligned array returned
   * without throwing would not.
   */
  it("always returns exactly one entry per line of nextContent, or throws — never a misaligned array", () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 20 }), fc.array(lineArb, { maxLength: 20 }), (beforeLines, afterLines) => {
        const previousContent = joinLines(beforeLines);
        const nextContent = joinLines(afterLines);
        const seeded = seedProvenance("doc", previousContent, 1, AT);

        let result;
        try {
          result = reconcileProvenance({
            previous: seeded.lines,
            previousContent,
            nextContent,
            agentId: "writer",
            contributionId: "c1",
            version: 2,
            at: AT,
          });
        } catch {
          return; // throwing satisfies "or throws"
        }
        expect(result.lines.length).toBe(splitLines(nextContent).length);
      }),
      props(4001),
    );
  });

  /**
   * OBSERVATION, not a REAL FINDING: reconcileProvenance's only use of
   * `input.previous` is index-based lookup inside its `carry()` helper
   * (provenance.ts:109-119), which falls back to a fresh anonymous entry for
   * any out-of-range index rather than ever touching `previous.length`
   * directly. The number of entries the loop pushes is governed entirely by
   * `oldLines.length` and the hunks from `diffLines(oldLines, newLines)` —
   * which, by construction, always describes an edit script that
   * reconstructs `newLines` exactly. So a `previous` array shorter or longer
   * than `previousContent`'s own line count can never trigger the
   * length-mismatch throw at provenance.ts:143-151; this property (and the
   * one above) hold on every input this suite can construct, which is
   * evidence the throw guard is currently unreachable dead code — not a bug
   * (the invariant it guards genuinely always holds today), but worth
   * flagging so a future change to diffLines or the cursor loop that could
   * break this invariant has a test watching it, not just a runtime throw
   * nobody has ever seen fire.
   */
  it("holds even when `previous` is shorter or longer than previousContent's own line count", () => {
    fc.assert(
      fc.property(
        fc.array(lineArb, { maxLength: 15 }),
        fc.array(lineArb, { maxLength: 15 }),
        fc.integer({ min: 0, max: 15 }),
        (beforeLines, afterLines, mismatchedLength) => {
          const previousContent = joinLines(beforeLines);
          const nextContent = joinLines(afterLines);
          const mismatchedPrevious = mkArbitraryProvenance(mismatchedLength);

          let result;
          try {
            result = reconcileProvenance({
              previous: mismatchedPrevious,
              previousContent,
              nextContent,
              agentId: "writer",
              contributionId: "c1",
              version: 2,
              at: AT,
            });
          } catch {
            return;
          }
          expect(result.lines.length).toBe(splitLines(nextContent).length);
        },
      ),
      props(4002),
    );
  });
});

describe("deleted lines drop their provenance; never shifted onto a neighbour", () => {
  /**
   * CONCORD_REVIEW_LOOP.md:76-77 — "Deleted lines drop their provenance; it
   * is never shifted onto a neighbour, which would misroute a comment."
   *
   * Built from globally-unique line content and pure deletion (no
   * insertions), so diffLines has no duplicate-content alignment ambiguity
   * to exploit — any surviving line's output entry must be traceable, by
   * exact lineId, to its own original entry and no other's.
   */
  const beforeAndMaskArb = fc
    .uniqueArray(lineArb, { minLength: 1, maxLength: 20 })
    .chain((beforeLines) =>
      fc.tuple(fc.constant(beforeLines), fc.array(fc.boolean(), { minLength: beforeLines.length, maxLength: beforeLines.length })),
    );

  it("a surviving line keeps its own lineId and attribution, never a deleted neighbour's", () => {
    fc.assert(
      fc.property(beforeAndMaskArb, ([beforeLines, keepMask]) => {
        const previousContent = joinLines(beforeLines);
        // Sidesteps the degenerate case where beforeLines collapses to the
        // singleton [""]: joinLines([""]) === "" === joinLines([]), so
        // splitLines can't tell a one-blank-line document from an empty one
        // (merge.ts:36,40).
        fc.pre(splitLines(previousContent).length === beforeLines.length);

        const seeded = seedProvenance("doc", previousContent, 1, AT);
        const keptIds = seeded.lines.filter((_, i) => keepMask[i]).map((l) => l.lineId);
        const keptLines = beforeLines.filter((_, i) => keepMask[i]);
        const nextContent = joinLines(keptLines);
        // Same collapse, other side: if exactly ONE line survives and that
        // line is "", nextContent is also "" — indistinguishable from
        // "nothing survived." fast-check's shrinker found this on its own
        // (counterexample beforeLines=[" ",""], keepMask=[false,true]) as a
        // genuine failure of THIS property's literal claim — but the
        // failure mode is "the surviving line's provenance vanishes
        // entirely," not "it inherits a deleted neighbour's identity." That
        // is a real, distinct finding (see the cross-cutting describe block
        // below, whose minimal reproducer is exactly this shrunk case), not
        // a counterexample to neighbour-shifting specifically — so it is
        // guarded out here rather than left to muddy what this property
        // actually claims.
        fc.pre(splitLines(nextContent).length === keptLines.length);

        const result = reconcileProvenance({
          previous: seeded.lines,
          previousContent,
          nextContent,
          agentId: "writer",
          contributionId: "c1",
          version: 2,
          at: AT,
        });

        expect(result.lines.map((l) => l.lineId)).toEqual(keptIds);
        expect(result.lines.every((l) => l.lastModifiedByAgentId === null)).toBe(true);
        expect(result.changedLineIds).toEqual([]);
      }),
      props(4003),
    );
  });
});

describe("inserted lines get fresh attribution", () => {
  /** CONCORD_REVIEW_LOOP.md:78 — "Inserted or replaced lines get fresh ids
   * attributed to the writing Agent." Built from a globally-unique pool
   * split into a base sequence (kept, unmodified) and spare lines (freshly
   * inserted at arbitrary positions), so — again — content is never
   * ambiguous between "kept" and "new". */
  const insertionCaseArb = fc.uniqueArray(lineArb, { minLength: 2, maxLength: 24 }).chain((pool) =>
    fc.integer({ min: 1, max: pool.length - 1 }).chain((baseCount) => {
      const baseLines = pool.slice(0, baseCount);
      const spareLines = pool.slice(baseCount);
      return fc.tuple(
        fc.constant(baseLines),
        fc.constant(spareLines),
        fc.array(fc.integer({ min: 0, max: baseCount }), { minLength: spareLines.length, maxLength: spareLines.length }),
      );
    }),
  );

  it("a freshly inserted line is attributed to the writing Agent with a lineId that reuses none of the previous entries", () => {
    fc.assert(
      fc.property(insertionCaseArb, ([baseLines, spareLines, positions]) => {
        const previousContent = joinLines(baseLines);
        fc.pre(splitLines(previousContent).length === baseLines.length);

        const seeded = seedProvenance("doc", previousContent, 1, AT);

        const slots: string[][] = Array.from({ length: baseLines.length + 1 }, () => []);
        spareLines.forEach((line, i) => slots[positions[i]!]!.push(line));

        const afterLines: string[] = [];
        const kind: Array<{ base: number } | { fresh: true }> = [];
        for (let i = 0; i <= baseLines.length; i += 1) {
          for (const line of slots[i]!) {
            afterLines.push(line);
            kind.push({ fresh: true });
          }
          if (i < baseLines.length) {
            afterLines.push(baseLines[i]!);
            kind.push({ base: i });
          }
        }
        const nextContent = joinLines(afterLines);

        const result = reconcileProvenance({
          previous: seeded.lines,
          previousContent,
          nextContent,
          agentId: "writer",
          contributionId: "c1",
          version: 2,
          at: AT,
        });

        const seededIds = new Set(seeded.lines.map((l) => l.lineId));
        result.lines.forEach((entry, pos) => {
          const k = kind[pos]!;
          if ("base" in k) {
            expect(entry.lineId).toBe(seeded.lines[k.base]!.lineId);
            expect(entry.lastModifiedByAgentId).toBeNull();
          } else {
            expect(entry.lastModifiedByAgentId).toBe("writer");
            expect(seededIds.has(entry.lineId)).toBe(false);
          }
        });
      }),
      props(4004),
    );
  });

  /** Deterministic regression combining both mechanisms in one commit,
   * mirroring provenance.test.ts's own hand-picked style — closes the loop
   * between the two property tests above without needing a combined
   * generator. */
  it("REGRESSION: a commit that both deletes and inserts keeps survivors' identity and freshly attributes only the new lines", () => {
    const before = ["alpha", "beta", "gamma", "delta"];
    const seeded = seedProvenance("doc", joinLines(before), 1, AT);
    // delete "beta", insert "NEW" between "gamma" and "delta"
    const next = joinLines(["alpha", "gamma", "NEW", "delta"]);
    const result = reconcileProvenance({
      previous: seeded.lines,
      previousContent: joinLines(before),
      nextContent: next,
      agentId: "writer",
      contributionId: "c1",
      version: 2,
      at: AT,
    });

    expect(result.lines).toHaveLength(4);
    expect(result.lines[0]?.lineId).toBe(seeded.lines[0]?.lineId); // alpha survives
    expect(result.lines[1]?.lineId).toBe(seeded.lines[2]?.lineId); // gamma survives with ITS OWN id, not beta's
    expect(result.lines[1]?.lastModifiedByAgentId).toBeNull();
    expect(result.lines[2]?.lastModifiedByAgentId).toBe("writer"); // NEW is fresh
    expect(result.lines[3]?.lineId).toBe(seeded.lines[3]?.lineId); // delta survives
    expect(result.changedLineIds).toEqual([result.lines[2]?.lineId]);
  });
});

describe("cross-cutting: a surviving lone blank line silently loses its provenance", () => {
  /**
   * REAL FINDING. Left failing on purpose. Same root cause as
   * merge.property.test.ts's pinned finding (merge.ts:36,40 —
   * splitLines("") === [] and joinLines([""]) === "": the one-blank-line
   * document and the zero-line document share a string encoding), but
   * reachable here even more directly than through merge3: fast-check's own
   * shrinker found it while falsifying the "never shifted onto a
   * neighbour" property above (counterexample beforeLines=[" ",""],
   * keepMask=[false,true] — deleting the first line and keeping the blank
   * second line loses that second line's provenance entirely). Minimal
   * reproducer below needs no merge at all: an ordinary delete that leaves
   * one blank line behind.
   *
   * reconcileProvenance computes newLines = splitLines(nextContent). When
   * the kept content is exactly one blank line, nextContent is the string
   * "", so newLines = [] — zero, not one. Because the invariant only checks
   * lines.length === newLines.length (both zero), nothing throws; the
   * surviving line's provenance just never exists. No comment could ever be
   * routed to whoever wrote it, silently violating
   * CONCORD_SHARED_STATE.md:6-9's one-sentence claim: "no edit is ever
   * silently lost."
   *
   * This is also reachable through the automatic merge path, not just a
   * direct write: merge.property.test.ts independently proves merge3() can
   * legitimately return { ok: true, content: "" } for ordinary disjoint
   * multi-line edits whose correct result is one surviving blank line
   * (re-verified directly here: merge3("a\nb", "b", "a\n") returns
   * content: ""). store.ts:579,581 feeds that exact merged.content straight
   * into commit(merged.content, "merged"), whose own comment
   * (store.ts:512-515) says attribution is computed "BEFORE anything is
   * mutated" specifically so a write is never half-applied — here it is
   * fully applied and fully silent instead, via store.ts:522's
   * reconcileProvenance({ nextContent: merged.content, ... }) call.
   *
   * Scope, stated honestly (matching merge.property.test.ts's own framing of
   * the same root cause): this fires only when the surviving content is
   * exactly one blank line — not for general content or attribution loss.
   */
  it("REAL FINDING: deleting down to one surviving blank line loses that line's provenance with no throw (provenance.ts:100-102's splitLines(nextContent))", () => {
    const previousContent = joinLines(["keep", ""]); // "keep\n" - 2 lines
    const seeded = seedProvenance("doc", previousContent, 1, AT);
    expect(seeded.lines).toHaveLength(2);

    const nextContent = joinLines([""]); // delete "keep"; the blank line survives
    expect(nextContent).toBe(""); // the encoding collision this finding is about

    const result = reconcileProvenance({
      previous: seeded.lines,
      previousContent,
      nextContent,
      agentId: "writer",
      contributionId: "c1",
      version: 2,
      at: AT,
    });

    // A document that should have exactly one line (the surviving blank
    // line) ends up with zero provenance entries for it.
    expect(result.lines).toHaveLength(1);
  });

  /** Same collapse, reached through the automatic merge path store.ts:579,581
   * actually uses in production - see the block comment above for the full
   * store.ts:522 <- store.ts:579,581 reachability chain. */
  it("REAL FINDING: the same collapse reached through merge3's own pinned blank-line-loss case", () => {
    const previousContent = "a\nb"; // matches merge.property.test.ts's pinned merge3 reproducer
    const seeded = seedProvenance("doc", previousContent, 1, AT);
    expect(seeded.lines).toHaveLength(2);

    // The exact content merge3("a\nb", "b", "a\n") returns today — re-derived
    // directly here (not hardcoded) so this test fails loudly if merge3's
    // behaviour ever changes out from under it.
    const merged = merge3("a\nb", "b", "a\n");
    expect(merged.ok).toBe(true);
    const nextContent = merged.ok ? merged.content : "";
    expect(nextContent).toBe("");

    const result = reconcileProvenance({
      previous: seeded.lines,
      previousContent,
      nextContent,
      agentId: "writer",
      contributionId: "c1",
      version: 2,
      at: AT,
    });

    expect(result.lines).toHaveLength(1);
  });
});

describe("responsibleAgents", () => {
  /** provenance.ts's doc: "Several Agents in range is ambiguous on purpose:
   * the caller must choose rather than have the platform guess." */
  const rangeAndOwnersArb = fc
    .array(fc.option(fc.constantFrom("agent-a", "agent-b", "agent-c"), { nil: null }), { minLength: 1, maxLength: 20 })
    .chain((owners) => fc.tuple(fc.constant(owners), fc.integer({ min: 1, max: owners.length }), fc.integer({ min: 1, max: owners.length })));

  it("is ambiguous iff more than one distinct Agent id appears in [startLine, endLine], and never guesses among them", () => {
    fc.assert(
      fc.property(rangeAndOwnersArb, ([owners, a, b]) => {
        const startLine = Math.min(a, b);
        const endLine = Math.max(a, b);
        const lines: LineProvenance[] = owners.map((owner, i) => ({
          lineId: "l" + i,
          lastModifiedByAgentId: owner,
          contributionId: owner ? "c" : null,
          resultingDocumentVersion: 1,
          updatedAt: AT,
        }));

        const result = responsibleAgents(lines, startLine, endLine);
        const distinct = new Set(owners.slice(startLine - 1, endLine).filter((o): o is string => o !== null));

        expect(result.ambiguous).toBe(distinct.size > 1);
        expect(result.recommendedAgentId).toBe(distinct.size === 1 ? [...distinct][0]! : null);
        expect([...result.candidateAgentIds].sort()).toEqual([...distinct].sort());
      }),
      props(4005),
    );
  });
});
