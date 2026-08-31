import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { props } from "../testing/fuzz.js";
import { diffLines, joinLines, merge3, splitLines } from "./merge.js";

/**
 * Property suite for the pure line-diff/merge core (see merge.ts's module
 * doc: "Line-based rather than character-based ... a merge that quietly
 * picks a winner is how you lose an Agent's work without noticing").
 *
 * Generators build multi-line content the way concord.test.ts's fixtures do
 * (strings joined with "\n"), but through fast-check so the shapes explored
 * go well past what a human would hand-pick.
 */


/** A single line's content: any string that cannot itself contain a "\n",
 * since embedding one would silently create extra lines and make the
 * generator's line count a lie. */
const lineArb = fc.string().filter((s) => !s.includes("\n"));

/** An array of lines, small enough to keep the O(n*m) LCS table cheap - which
 * matters far more in the fuzz lane, where the same generator runs orders of
 * magnitude more cases and a quadratic blow-up would eat the time budget
 * before it explored anything interesting. */
const linesArb = (maxLength = 12) => fc.array(lineArb, { maxLength });

/** Multi-line document content, built the same way the task brief suggests:
 * fc.array(fc.string()).map(a => a.join("\n")). */
const contentArb = (maxLength = 12) => linesArb(maxLength).map(joinLines);

describe("splitLines / joinLines round-trip", () => {
  it("joinLines(splitLines(text)) reconstructs any string", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(joinLines(splitLines(text))).toBe(text);
      }),
      props(1001),
    );
  });

  /**
   * REAL FINDING. splitLines special-cases the empty string to mean "zero
   * lines" (merge.ts:38: `text.length === 0 ? [] : text.split("\n")`), so a
   * one-element array holding a single blank line — [""] — and the empty
   * array [] are NOT distinguishable after a join/split round trip: both
   * serialise to "" and both deserialise back to [].
   *
   * Minimal counterexample: lines = [""].
   *   joinLines([""])            === ""   (Array.prototype.join of one item)
   *   splitLines(joinLines([""])) -> []    !==  [""]
   *
   * Plain fc.array() rarely lands on exactly "one element, and that element
   * is empty" by chance, so [""] is seeded into the generator explicitly —
   * otherwise this property passes 200/200 by luck and the finding goes
   * unnoticed (it did, on the first run of this suite).
   *
   * [""] is not itself a value splitLines ever produces (splitLines("") is
   * [], not [""]), so on its own this property tests an inverse outside
   * splitLines's image — a skeptical reader could dismiss it as out of
   * codomain. It is not dismissible: see "REAL FINDING, reachable through
   * merge3" below, which reaches the identical root cause through the
   * public merge3(base, ours, theirs) entry point on ordinary multi-line
   * text documents, no synthetic line array required.
   */
  it("splitLines(joinLines(lines)) reconstructs the line array", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant([""]), linesArb()), (lines) => {
        expect(splitLines(joinLines(lines))).toEqual(lines);
      }),
      props(1002),
    );
  });

  /** Permanent, deterministic regression pin for the finding above — no
   * randomness, so it cannot pass by sampling luck the way the property
   * above did before [""] was seeded into its generator. */
  it("REGRESSION: a single blank line does not collapse to zero lines", () => {
    expect(splitLines(joinLines([""]))).toEqual([""]);
  });

  /**
   * REAL FINDING, reachable through merge3. merge.ts:131 promises "Disjoint
   * edits converge" — but when two genuinely disjoint one-sided edits leave
   * a merge result that reduces to exactly one blank line, merge3 reports
   * `ok: true` while silently discarding it, because the same splitLines
   * collapse pinned above fires one level up: the internal `joinLines(merged)`
   * produces a single "\n"-free empty string, which is the same encoding as
   * zero lines, so the surviving blank line is unrecoverable from `content`
   * alone.
   *
   * Found via direct probing of merge3's public signature (not a fast-check
   * shrink) over ordinary text documents:
   *   base="a\nb", ours="b", theirs="a\n"
   *     ours deletes the line "a" (keeps "b")
   *     theirs deletes the line "b" and appends a trailing blank line
   *       (keeps "a", i.e. splitLines(theirs) = ["a", ""])
   *     these are disjoint edits to different base lines — no conflict
   *   merge3(base, ours, theirs) -> { ok: true, content: "" }
   *     the disjoint splice actually computes the line array [""] (one
   *     surviving blank line from theirs' trailing newline), but
   *     joinLines([""]) === "" and the caller only ever sees `content`,
   *     which reads back as zero lines, not one.
   *
   * Scope, stated honestly: this is narrow. It only fires when the merged
   * result reduces to exactly a single blank line — general content is not
   * lost (see "merge3 never invents content" and the disjoint-edit property
   * above, both passing across hundreds of non-degenerate cases). It is a
   * real, low-severity defect in the documented "disjoint edits converge"
   * guarantee, not a general merge-correctness bug.
   */
  it("REAL FINDING: a disjoint merge that reduces to one blank line loses it (merge.ts:131 'Disjoint edits converge')", () => {
    const result = merge3("a\nb", "b", "a\n");
    expect(result.ok).toBe(true);
    // "Disjoint edits converge" promises the surviving blank line from
    // theirs' trailing newline is still there. Instead, merge3 currently
    // returns content: "" (splitLines(content) === [], not [""]) — this
    // assertion is left failing on purpose to pin the defect.
    if (result.ok) expect(splitLines(result.content)).toEqual([""]);
  });
});

describe("merge3 identity cases", () => {
  it("merge3(base, x, x) always agrees with x and touches nothing", () => {
    fc.assert(
      fc.property(contentArb(), contentArb(), (base, x) => {
        const result = merge3(base, x, x);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.content).toBe(x);
          expect(result.hunks).toBe(0);
        }
      }),
      props(1003),
    );
  });

  it("merge3(base, base, theirs) === theirs — an untouched side yields the other side's content", () => {
    fc.assert(
      fc.property(contentArb(), contentArb(), (base, theirs) => {
        const result = merge3(base, base, theirs);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.content).toBe(theirs);
      }),
      props(1004),
    );
  });

  it("merge3(base, ours, base) === ours — the mirror of the above", () => {
    fc.assert(
      fc.property(contentArb(), contentArb(), (base, ours) => {
        const result = merge3(base, ours, base);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.content).toBe(ours);
      }),
      props(1005),
    );
  });
});

describe("merge3 is symmetric in ours/theirs", () => {
  /**
   * Swapping ours and theirs must either conflict both ways, or produce the
   * same merged content both ways. `overlaps()` (merge.ts:120-126) is
   * defined symmetrically in a and b, so which side is "ours" and which is
   * "theirs" cannot change whether a same-line disagreement is detected —
   * only which side's text ends up labelled ours/theirs in the conflict
   * record.
   */
  it("conflicts either way, or agrees on content either way", () => {
    fc.assert(
      fc.property(contentArb(8), contentArb(8), contentArb(8), (base, ours, theirs) => {
        const forward = merge3(base, ours, theirs);
        const swapped = merge3(base, theirs, ours);
        expect(forward.ok).toBe(swapped.ok);
        if (forward.ok && swapped.ok) {
          expect(forward.content).toBe(swapped.content);
          expect(forward.hunks).toBe(swapped.hunks);
        }
      }),
      props(1006),
    );
  });

  it("conflict sets mirror ours/theirs when swapped", () => {
    fc.assert(
      fc.property(contentArb(8), contentArb(8), contentArb(8), (base, ours, theirs) => {
        const forward = merge3(base, ours, theirs);
        const swapped = merge3(base, theirs, ours);
        if (forward.ok || swapped.ok) return; // only conflicting cases are interesting here
        // Canonicalise each conflict set as a sorted list of keys, with
        // ours/theirs swapped for the `swapped` call, so set-equality survives
        // any difference in iteration order between the two calls.
        const keyOf = (c: { baseStart: number; baseEnd: number; ours: readonly string[]; theirs: readonly string[] }, swap: boolean) =>
          [c.baseStart, c.baseEnd, (swap ? c.theirs : c.ours).join(" "), (swap ? c.ours : c.theirs).join(" ")].join("|");
        const forwardKeys = forward.conflicts.map((c) => keyOf(c, false)).sort();
        const swappedKeys = swapped.conflicts.map((c) => keyOf(c, true)).sort();
        expect(swappedKeys).toEqual(forwardKeys);
      }),
      props(1007),
    );
  });
});

describe("clean merges preserve one-sided edits", () => {
  /**
   * Two markers ("OURS:" vs "THEIRS:" vs no marker for the untouched base)
   * can never collide by construction — string equality requires the first
   * characters to match, and the three prefixes differ there — so this
   * builds a genuinely disjoint edit (left half changed by ours, right half
   * changed by theirs) without depending on merge3's own overlap detection
   * to decide what counts as disjoint.
   *
   * TEST BUGS (found and fixed here, not new findings — two, discovered in
   * two rounds of shrinking):
   *
   * 1. The first version had no guard against the already-documented
   *    splitLines/joinLines asymmetry above (a single blank line collapses to
   *    zero lines on a join/split round trip). When `right` degenerates to
   *    exactly `[""]` with `oursEdit` empty, `joinLines([...oursLeft,
   *    ...right])` collapses to `""`, and merge3's own internal
   *    `splitLines(ours)` then reads it back as `[]` — zero lines, not one.
   *    Shrunk counterexample: base=["",""], splitSeed=0, oursEdit=[],
   *    theirsEdit=[""]. Fixed by the `fc.pre()` round-trip guards below —
   *    the already-broken case stays covered, precisely and only, by the
   *    round-trip property/regression above.
   *
   * 2. Even with that guard, a second, distinct issue shrunk out: base with
   *    REPEATED identical lines (e.g. base=["","",""]) breaks the "left
   *    half / right half" positional model this test relies on. diffLines is
   *    a content-based LCS diff with no line-identity tracking (merge.ts's
   *    module doc: "Line-based rather than character-based", not
   *    identity-based), so when several base lines are byte-identical, the
   *    diff against `ours` may align the *unchanged* copies differently than
   *    the diff against `theirs` does — e.g. ours's diff decides base[2] was
   *    "deleted" while theirs's diff decides base[1..2] was "deleted",
   *    purely because content-only LCS has no way to know these are the
   *    "same" occurrence I intended. Confirmed via direct inspection for the
   *    shrunk counterexample (base=["","",""], splitSeed=0, oursEdit=[],
   *    theirsEdit=[""]):
   *      ourHunks   = [{ start: 2, deleted: 1, inserted: [] }]
   *      theirHunks = [{ start: 1, deleted: 2, inserted: ["THEIRS:"] }]
   *    These genuinely overlap (base range [2,3) vs [1,3)), so merge3
   *    correctly reports a conflict for what its content-based diff sees —
   *    it just isn't the "obviously disjoint" edit this test intended to
   *    build, because "OURS:"/"THEIRS:" markers only guarantee the *edited*
   *    lines never collide, not that duplicate *unedited* base lines resolve
   *    to a stable identity. This is exactly the documented trade-off in
   *    docs/CONCORD_SHARED_STATE.md §4 ("a line-based merge cannot resolve
   *    two edits to the *same* line... reports a conflict where a CRDT would
   *    converge on something") applied to an ambiguous-identity case, not a
   *    bug in overlap detection. Fixed by requiring base lines to be
   *    pairwise distinct, which removes the identity ambiguity and makes the
   *    left/right split unambiguous to the diff algorithm too.
   */
  it("a disjoint edit on each side survives in the merged content", () => {
    fc.assert(
      fc.property(
        linesArb(10).filter((l) => l.length >= 2 && new Set(l).size === l.length),
        fc.integer({ min: 0, max: 1_000_000 }),
        linesArb(6),
        linesArb(6),
        (base, splitSeed, oursEdit, theirsEdit) => {
          const k = 1 + (splitSeed % (base.length - 1)); // 0 < k < base.length
          const left = base.slice(0, k);
          const right = base.slice(k);

          const oursLeft = oursEdit.map((s) => "OURS:" + s);
          const theirsRight = theirsEdit.map((s) => "THEIRS:" + s);

          const oursArr = [...oursLeft, ...right];
          const theirsArr = [...left, ...theirsRight];

          // Skip inputs where join/split does not round-trip faithfully for
          // the constructed side — that is finding (1) above, not this
          // property's concern.
          fc.pre(splitLines(joinLines(oursArr)).length === oursArr.length);
          fc.pre(splitLines(joinLines(theirsArr)).length === theirsArr.length);

          const ours = joinLines(oursArr);
          const theirs = joinLines(theirsArr);
          const base_ = joinLines(base);

          const result = merge3(base_, ours, theirs);
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(splitLines(result.content)).toEqual([...oursLeft, ...theirsRight]);
          }
        },
      ),
      props(1008),
    );
  });
});

describe("merge3 never invents content", () => {
  it("every merged line came from base, ours, or theirs", () => {
    fc.assert(
      fc.property(contentArb(10), contentArb(10), contentArb(10), (base, ours, theirs) => {
        const result = merge3(base, ours, theirs);
        if (!result.ok) return;
        const known = new Set([...splitLines(base), ...splitLines(ours), ...splitLines(theirs)]);
        for (const line of splitLines(result.content)) {
          expect(known.has(line)).toBe(true);
        }
      }),
      props(1009),
    );
  });
});

describe("diffLines hunks partition the target", () => {
  /** Supporting sanity check for the properties above: hunks from diffLines
   * are always in ascending, non-overlapping base-coordinate order, which is
   * what lets merge3 detect overlap by simple pairwise comparison. */
  it("hunks are strictly ascending in start position", () => {
    fc.assert(
      fc.property(linesArb(10), linesArb(10), (base, other) => {
        const hunks = diffLines(base, other);
        for (let i = 1; i < hunks.length; i += 1) {
          expect(hunks[i]!.start).toBeGreaterThan(hunks[i - 1]!.start);
        }
      }),
      props(1010),
    );
  });
});
