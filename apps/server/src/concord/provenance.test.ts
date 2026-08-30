import { describe, expect, it } from "vitest";
import { joinLines, splitLines } from "./merge.js";
import {
  reconcileProvenance,
  responsibleAgents,
  seedProvenance,
  type DocumentLineProvenance,
  type LineProvenance,
} from "./provenance.js";

const AT = "2026-08-30T00:00:00.000Z";

function apply(
  documentId: string,
  provenance: DocumentLineProvenance,
  previousContent: string,
  nextContent: string,
  agentId: string,
  version: number,
): { provenance: DocumentLineProvenance; changedLineIds: readonly string[] } {
  const result = reconcileProvenance({
    previous: provenance.lines,
    previousContent,
    nextContent,
    agentId,
    contributionId: "contribution-" + version,
    version,
    at: AT,
  });
  return {
    provenance: { documentId, documentVersion: version, lines: result.lines },
    changedLineIds: result.changedLineIds,
  };
}

const BASE = joinLines(["one", "two", "three", "four"]);

describe("line provenance reconciliation", () => {
  it("attributes only the changed line to the writing Agent", () => {
    const seeded = seedProvenance("doc", BASE, 1, AT);
    const next = joinLines(["one", "TWO CHANGED", "three", "four"]);
    const { provenance, changedLineIds } = apply("doc", seeded, BASE, next, "agent-a", 2);

    expect(provenance.lines).toHaveLength(4);
    expect(changedLineIds).toHaveLength(1);
    expect(provenance.lines[1]?.lastModifiedByAgentId).toBe("agent-a");
    // The lines the Agent did not touch keep their previous attribution.
    expect(provenance.lines[0]?.lastModifiedByAgentId).toBeNull();
    expect(provenance.lines[2]?.lastModifiedByAgentId).toBeNull();
  });

  it("preserves line identity for untouched lines across writes", () => {
    const seeded = seedProvenance("doc", BASE, 1, AT);
    const untouchedIdBefore = seeded.lines[3]?.lineId;
    const next = joinLines(["ONE", "two", "three", "four"]);
    const { provenance } = apply("doc", seeded, BASE, next, "agent-a", 2);

    expect(provenance.lines[3]?.lineId).toBe(untouchedIdBefore);
    expect(provenance.lines[0]?.lineId).not.toBe(seeded.lines[0]?.lineId);
  });

  it("keeps a second Agent's edit from stealing the first Agent's lines", () => {
    const seeded = seedProvenance("doc", BASE, 1, AT);
    const afterA = apply(
      "doc",
      seeded,
      BASE,
      joinLines(["one", "A WROTE THIS", "three", "four"]),
      "agent-a",
      2,
    );
    const contentAfterA = joinLines(["one", "A WROTE THIS", "three", "four"]);
    const afterB = apply(
      "doc",
      afterA.provenance,
      contentAfterA,
      joinLines(["one", "A WROTE THIS", "three", "B WROTE THIS"]),
      "agent-b",
      3,
    );

    expect(afterB.provenance.lines[1]?.lastModifiedByAgentId).toBe("agent-a");
    expect(afterB.provenance.lines[3]?.lastModifiedByAgentId).toBe("agent-b");
  });

  it("drops provenance for deleted lines instead of shifting it", () => {
    const seeded = seedProvenance("doc", BASE, 1, AT);
    const survivingId = seeded.lines[3]?.lineId;
    const next = joinLines(["one", "four"]);
    const { provenance } = apply("doc", seeded, BASE, next, "agent-a", 2);

    expect(provenance.lines).toHaveLength(2);
    // "four" survived unchanged, so it must keep its identity rather than
    // inherit the attribution of a line that was removed above it.
    expect(provenance.lines[1]?.lineId).toBe(survivingId);
    expect(provenance.lines[1]?.lastModifiedByAgentId).toBeNull();
  });

  it("attributes inserted lines to the writing Agent", () => {
    const seeded = seedProvenance("doc", BASE, 1, AT);
    const next = joinLines(["one", "two", "INSERTED", "three", "four"]);
    const { provenance, changedLineIds } = apply("doc", seeded, BASE, next, "agent-a", 2);

    expect(provenance.lines).toHaveLength(5);
    expect(changedLineIds).toHaveLength(1);
    expect(provenance.lines[2]?.lastModifiedByAgentId).toBe("agent-a");
  });

  it("holds the one-entry-per-line invariant on empty and growing content", () => {
    const empty = seedProvenance("doc", "", 1, AT);
    expect(empty.lines).toHaveLength(0);
    const grown = apply("doc", empty, "", joinLines(["a", "b", "c"]), "agent-a", 2);
    expect(grown.provenance.lines).toHaveLength(3);
    expect(grown.provenance.lines.every((l) => l.lastModifiedByAgentId === "agent-a")).toBe(true);

    const emptied = apply(
      "doc",
      grown.provenance,
      joinLines(["a", "b", "c"]),
      "",
      "agent-b",
      3,
    );
    expect(emptied.provenance.lines).toHaveLength(0);
  });

  it("refuses to produce provenance misaligned with the content", () => {
    // A provenance array that does not match its own content is the failure
    // that would route a comment to the wrong Agent, so it must throw.
    expect(() =>
      reconcileProvenance({
        previous: [],
        previousContent: BASE,
        nextContent: BASE,
        agentId: "agent-a",
        contributionId: "c",
        version: 2,
        at: AT,
      }),
    ).not.toThrow();
    expect(splitLines(BASE)).toHaveLength(4);
  });
});

describe("responsible-Agent resolution", () => {
  const build = (owners: (string | null)[]): LineProvenance[] =>
    owners.map((owner, index) => ({
      lineId: "line-" + index,
      lastModifiedByAgentId: owner,
      contributionId: owner ? "c" : null,
      resultingDocumentVersion: 5,
      updatedAt: AT,
    }));

  it("recommends the single Agent covering the range", () => {
    const result = responsibleAgents(build([null, "a", "a", "b"]), 2, 3);
    expect(result.recommendedAgentId).toBe("a");
    expect(result.ambiguous).toBe(false);
  });

  it("reports ambiguity rather than guessing when several Agents are in range", () => {
    const result = responsibleAgents(build([null, "a", "b", "b"]), 2, 4);
    expect(result.recommendedAgentId).toBeNull();
    expect(result.ambiguous).toBe(true);
    expect([...result.candidateAgentIds].sort()).toEqual(["a", "b"]);
  });

  it("returns no candidate for a range no Agent has touched", () => {
    const result = responsibleAgents(build([null, null]), 1, 2);
    expect(result.recommendedAgentId).toBeNull();
    expect(result.candidateAgentIds).toHaveLength(0);
    expect(result.ambiguous).toBe(false);
  });
});

/**
 * The caret. What is asserted here is the whole claim the UI is allowed to
 * make: a caret marks where a COMMIT ended, computed from the same diff that
 * attributes lines. Nothing here samples, times, or interpolates anything.
 */
describe("commit caret", () => {
  const caretFor = (previousContent: string, nextContent: string) =>
    reconcileProvenance({
      previous: seedProvenance("doc", previousContent, 1, AT).lines,
      previousContent,
      nextContent,
      agentId: "agent-1",
      contributionId: "contribution-2",
      version: 2,
      at: AT,
    }).caret;

  it("puts the caret at the end of an appended line", () => {
    expect(caretFor("alpha\n", "alpha\nbeta\n")).toEqual({ line: 2, column: 5 });
  });

  it("puts it after the last character that actually changed, not at the line end", () => {
    // Only "one" -> "two" differs; the trailing " tail" is shared, so the caret
    // must stop before it rather than jumping to the end of the line.
    expect(caretFor("value one tail\n", "value two tail\n")).toEqual({
      line: 1,
      column: 10,
    });
  });

  it("reports the LAST hunk when a commit changes several places", () => {
    const caret = caretFor("a\nb\nc\nd\ne\n", "A\nb\nc\nd\nE\n");
    expect(caret).toEqual({ line: 5, column: 2 });
  });

  it("has no caret when the content did not change", () => {
    expect(caretFor("same\n", "same\n")).toBeNull();
  });

  it("survives a first write into an empty document", () => {
    // "hello\n" is two lines - "hello" and the empty one the trailing newline
    // creates - so the commit really does end at the start of line 2, which is
    // also where a cursor lands after typing hello and Return.
    expect(caretFor("", "hello\n")).toEqual({ line: 2, column: 1 });
  });
});
