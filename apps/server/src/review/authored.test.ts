import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_COMMENTS_PER_TURN,
  MAX_AGENT_COMMENT_BODY,
  parseAuthored,
  withAuthoredInstruction,
} from "./authored.js";

describe("parseAuthored", () => {
  it("reads a well-formed review marker", () => {
    const { comments } = parseAuthored(
      "I looked at the retry helper.\nCONCORD-REVIEW: L3-L7 the retry loop never backs off\n",
    );
    expect(comments).toEqual([
      { startLine: 3, endLine: 7, body: "the retry loop never backs off" },
    ]);
  });

  it("accepts the range with or without the L prefix", () => {
    expect(parseAuthored("CONCORD-REVIEW: 3-7 no backoff").comments[0]).toMatchObject({
      startLine: 3,
      endLine: 7,
    });
    expect(parseAuthored("CONCORD-REVIEW: L3 - L7 no backoff").comments[0]).toMatchObject({
      startLine: 3,
      endLine: 7,
    });
  });

  it("normalises a reversed range rather than dropping it", () => {
    // A model writing L9-L4 means the same lines. Refusing it would be
    // pedantry the reviewer pays for.
    expect(parseAuthored("CONCORD-REVIEW: L9-L4 off by one").comments[0]).toMatchObject({
      startLine: 4,
      endLine: 9,
    });
  });

  it("keeps every distinct comment, unlike the last-wins checkpoint rule", () => {
    const { comments } = parseAuthored(
      ["CONCORD-REVIEW: L1-L2 first", "CONCORD-REVIEW: L5-L6 second"].join("\n"),
    );
    expect(comments.map((comment) => comment.body)).toEqual(["first", "second"]);
  });

  it("dedupes a restated marker BEFORE spending the cap", () => {
    // A model that restates its plan before acting would otherwise burn the
    // whole budget on one comment.
    const { comments } = parseAuthored(
      [
        "I will report this:",
        "CONCORD-REVIEW: L1-L2 same point",
        "Done. To repeat:",
        "CONCORD-REVIEW: L1-L2 same point",
        "CONCORD-REVIEW: L4-L5 a real second point",
      ].join("\n"),
    );
    expect(comments).toHaveLength(2);
  });

  it("caps the number of comments per turn", () => {
    const many = Array.from(
      { length: MAX_AGENT_COMMENTS_PER_TURN + 3 },
      (_, index) => "CONCORD-REVIEW: L" + (index + 1) + "-L" + (index + 2) + " point " + index,
    ).join("\n");
    expect(parseAuthored(many).comments).toHaveLength(MAX_AGENT_COMMENTS_PER_TURN);
  });

  it("truncates an over-long body", () => {
    const { comments } = parseAuthored("CONCORD-REVIEW: L1-L2 " + "x".repeat(900));
    expect(comments[0]?.body).toHaveLength(MAX_AGENT_COMMENT_BODY);
    expect(comments[0]?.body.endsWith("…")).toBe(true);
  });

  it("ignores the marker mid-sentence, because the pattern is line-anchored", () => {
    expect(
      parseAuthored("I considered whether to CONCORD-REVIEW: L1-L2 this but did not").comments,
    ).toEqual([]);
  });

  it("ignores a marker with no body", () => {
    expect(parseAuthored("CONCORD-REVIEW: L1-L2").comments).toEqual([]);
    expect(parseAuthored("CONCORD-REVIEW: L1-L2   ").comments).toEqual([]);
  });

  it("reads resolutions by ordinal", () => {
    const { resolves } = parseAuthored(
      "CONCORD-RESOLVE: 2 the backoff is in and the test covers it",
    );
    expect(resolves).toEqual([
      { ordinal: 2, reason: "the backoff is in and the test covers it" },
    ]);
  });

  it("accepts a resolution with no reason, and dedupes repeats", () => {
    const { resolves } = parseAuthored("CONCORD-RESOLVE: 1\nCONCORD-RESOLVE: 1 again");
    expect(resolves).toEqual([{ ordinal: 1, reason: "" }]);
  });

  it("reads both markers out of one reply", () => {
    const parsed = parseAuthored(
      [
        "CONCORD-RESOLVE: 1 fixed the backoff",
        "CONCORD-REVIEW: L20-L21 the caller still swallows the error",
      ].join("\n"),
    );
    expect(parsed.resolves).toHaveLength(1);
    expect(parsed.comments).toHaveLength(1);
  });

  it("still parses a marker inside a fenced block", () => {
    // Documented, not prevented - parseCheckpoint has the same exposure, and
    // stripping fences would be a markdown parser nobody asked for.
    expect(parseAuthored("```\nCONCORD-REVIEW: L1-L2 inside a fence\n```").comments)
      .toHaveLength(1);
  });

  it("returns nothing for output with no markers", () => {
    expect(parseAuthored("I finished the section and changed nothing else.")).toEqual({
      comments: [],
      resolves: [],
    });
  });
});

describe("withAuthoredInstruction", () => {
  it("omits the resolve half for a work turn, which numbers no comments", () => {
    const prompt = withAuthoredInstruction("do the work", { resolve: false });
    expect(prompt).toContain("CONCORD-REVIEW:");
    expect(prompt).not.toContain("CONCORD-RESOLVE:");
  });

  it("includes both halves for a re-iteration", () => {
    const prompt = withAuthoredInstruction("address these", { resolve: true });
    expect(prompt).toContain("CONCORD-REVIEW:");
    expect(prompt).toContain("CONCORD-RESOLVE:");
  });

  it("keeps the original prompt intact", () => {
    expect(withAuthoredInstruction("the original ask", { resolve: true })).toContain(
      "the original ask",
    );
  });
});
