/**
 * CONCORD_REVIEW_LOOP.md, "Context retrieval, and why there is no vector
 * database":
 *
 *   "Retrieval is the selected range, a bounded window either side, and the
 *   whole document when it fits under 40 KB."
 *
 * src/review/reiteration.ts encodes this as two constants that are not
 * exported:
 *
 *   const WINDOW = 40;
 *   const MAX_CONTEXT_BYTES = 40_000;
 *
 * and picks a path with `content.length <= MAX_CONTEXT_BYTES ? numbered(...)
 * : windowed(...)`. The only existing coverage (review.test.ts, "bounds the
 * context for a document too large to inline") checks that omission markers
 * show up somewhere in a document "comfortably past" the threshold - it never
 * pins the byte count or the window width, so an off-by-one in either
 * constant (39 or 41 lines of window; 39_999 or 40_001 bytes as the cutoff)
 * would not be caught by anything in this repo.
 *
 * These tests pin the exact boundaries: a document at exactly 40_000 bytes
 * (still inlined, since the check is `<=`) and one at exactly 40_001 bytes
 * (windowed), and a comment whose window edge (start-1 / end+1) sits on
 * specific, computed line numbers rather than "somewhere past a big number".
 * The window and byte-threshold values below (40 and 40_000) are hardcoded
 * from the doc's own words, not read from reiteration.ts, so a change to
 * either constant would make these tests fail rather than silently track it.
 */

import { describe, expect, it } from "vitest";
import { splitLines } from "../concord/merge.js";
import { compileReiterationPrompt } from "./reiteration.js";
import type { ReviewComment } from "./types.js";

const WINDOW = 40;
const MAX_CONTEXT_BYTES = 40_000;

/**
 * Builds a document of exactly `targetLength` characters out of "x"-filled
 * lines, so byte counts are exact and line boundaries stay legible. Every
 * line but the last is `lineWidth` characters; the last is whatever is left,
 * so the join (lines + "\n" separators) lands on `targetLength` exactly.
 */
function docOfExactLength(targetLength: number, lineWidth = 10): string {
  const lines: string[] = [];
  let length = 0;
  for (;;) {
    const separator = lines.length > 0 ? 1 : 0;
    if (length + separator + lineWidth <= targetLength) {
      lines.push("x".repeat(lineWidth));
      length += separator + lineWidth;
      continue;
    }
    const remaining = targetLength - length - separator;
    if (remaining > 0) {
      lines.push("x".repeat(remaining));
      length += separator + remaining;
    }
    break;
  }
  return lines.join("\n");
}

/** Every "N | ..." line-number prefix `numbered()`/`windowed()` printed. */
function lineNumbersIn(promptBody: string): number[] {
  return [...promptBody.matchAll(/^(\d+) \| /gm)].map((m) => Number(m[1]));
}

function commentAt(startLine: number, endLine: number): ReviewComment {
  return { startLine, endLine, selectedText: "x", body: "context window probe" } as ReviewComment;
}

describe("the 40 KB whole-document threshold", () => {
  it("inlines the whole document at exactly 40,000 bytes (<=, not <)", () => {
    const doc = docOfExactLength(MAX_CONTEXT_BYTES);
    expect(doc.length).toBe(40_000);
    const totalLines = splitLines(doc).length;

    const prompt = compileReiterationPrompt("doc.ts", doc, 1, [commentAt(1, 1)]);

    expect(prompt).not.toContain("earlier lines omitted");
    expect(prompt).not.toContain("later lines omitted");
    const numbers = lineNumbersIn(prompt);
    expect(Math.min(...numbers)).toBe(1);
    expect(Math.max(...numbers)).toBe(totalLines);
    // Contiguous, one entry per line: the whole document, nothing windowed out.
    expect(numbers).toHaveLength(totalLines);
  });

  it("switches to the windowed path at 40,001 bytes - one byte over the limit", () => {
    const doc = docOfExactLength(MAX_CONTEXT_BYTES + 1);
    expect(doc.length).toBe(40_001);
    const totalLines = splitLines(doc).length;
    const mid = Math.floor(totalLines / 2);
    // The document must be large enough that the window doesn't reach either
    // edge, or this test would not actually distinguish the two code paths.
    expect(mid - WINDOW).toBeGreaterThan(1);
    expect(mid + WINDOW).toBeLessThan(totalLines);

    const prompt = compileReiterationPrompt("doc.ts", doc, 1, [commentAt(mid, mid)]);

    expect(prompt).toContain("earlier lines omitted");
    expect(prompt).toContain("later lines omitted");
  });
});

describe("the 40-line window either side of a comment", () => {
  it("includes exactly the line 40 away and excludes the line 41 away", () => {
    const doc = docOfExactLength(MAX_CONTEXT_BYTES + 1);
    const totalLines = splitLines(doc).length;
    const mid = Math.floor(totalLines / 2);
    expect(mid - (WINDOW + 1)).toBeGreaterThan(1);
    expect(mid + (WINDOW + 1)).toBeLessThan(totalLines);

    const prompt = compileReiterationPrompt("doc.ts", doc, 1, [commentAt(mid, mid)]);
    const numbers = lineNumbersIn(prompt);

    const expectedStart = mid - WINDOW;
    const expectedEnd = mid + WINDOW;
    expect(Math.min(...numbers)).toBe(expectedStart);
    expect(Math.max(...numbers)).toBe(expectedEnd);
    expect(numbers).toHaveLength(expectedEnd - expectedStart + 1);

    // Pin the omission counts too: they are the doc's own arithmetic
    // (start - 1 earlier, totalLines - end later), so an off-by-one in
    // WINDOW would move these numbers as well as the min/max above.
    expect(prompt).toContain("... " + (expectedStart - 1) + " earlier lines omitted ...");
    expect(prompt).toContain("... " + (totalLines - expectedEnd) + " later lines omitted ...");
  });

  it("clamps the window at the start of the document instead of going negative", () => {
    const doc = docOfExactLength(MAX_CONTEXT_BYTES + 1);
    const totalLines = splitLines(doc).length;
    // A comment close enough to line 1 that start - WINDOW would be < 1.
    const near = 10;
    expect(near).toBeLessThan(WINDOW);
    expect(near + WINDOW).toBeLessThan(totalLines);

    const prompt = compileReiterationPrompt("doc.ts", doc, 1, [commentAt(near, near)]);
    const numbers = lineNumbersIn(prompt);

    expect(Math.min(...numbers)).toBe(1);
    expect(Math.max(...numbers)).toBe(near + WINDOW);
    // Clamped to the real start of the document: nothing earlier to omit.
    expect(prompt).not.toContain("earlier lines omitted");
    expect(prompt).toContain(
      "... " + (totalLines - (near + WINDOW)) + " later lines omitted ...",
    );
  });
});
