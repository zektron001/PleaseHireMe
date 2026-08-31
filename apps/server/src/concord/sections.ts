/**
 * Section ownership — the rule that makes "Agents do not collide" structural
 * rather than lucky.
 *
 * CONCORD's three-way merge already guarantees nobody is silently overwritten.
 * That is a guarantee about the *outcome* of a race. This module removes the
 * race: the orchestrator allocates each Agent one named section of a document,
 * and a write that changes a line outside it is refused before it can commit.
 *
 * So two Agents working the same file at the same time are not merely merged
 * afterwards; they were never able to touch the same lines. The merge stays in
 * place underneath, because an allocation is not a lock: a human editing the
 * file, or a resolved conflict, can still move lines under an Agent's feet.
 *
 *   allocation   who MAY change these lines            (refused before commit)
 *   merge        what happens when two changes race    (never a silent loss)
 *   lease        a temporary exclusive claim            (unchanged)
 *
 * A document with NO allocations is unrestricted, which is what keeps every
 * existing behaviour - and every existing test - exactly as it was.
 */

import { splitLines, diffLines } from "./merge.js";

export interface SectionAllocation {
  readonly docId: string;
  readonly agentId: string;
  /**
   * The heading line that opens the section, matched exactly against the
   * document's current content. Stored as text rather than as a line number
   * because line numbers move every time anybody writes.
   */
  readonly heading: string;
}

export interface SectionRange {
  /** 1-based, inclusive. The heading line itself is part of the section. */
  readonly startLine: number;
  readonly endLine: number;
}

/** `## Foo` -> 2. Zero when the line is not a heading. */
function headingLevel(line: string): number {
  const match = /^(#{1,6})\s/.exec(line);
  return match ? (match[1] as string).length : 0;
}

/**
 * Where a section lives in this content, or null when its heading is absent.
 *
 * A section runs from its heading to the line before the next heading of the
 * same or a higher level - so `## B` ends `## A`, and so does `# C`, but a
 * nested `### A1` does not. That is the same nesting rule Markdown readers
 * apply, which matters: the boundary a human sees has to be the boundary the
 * middleware enforces, or the refusals will look arbitrary.
 */
export function locateSection(content: string, heading: string): SectionRange | null {
  const lines = splitLines(content);
  const wanted = heading.trim();
  const index = lines.findIndex((line) => line.trim() === wanted);
  if (index === -1) return null;

  const level = headingLevel(lines[index] as string);
  let end = lines.length;
  for (let i = index + 1; i < lines.length; i += 1) {
    const candidate = headingLevel(lines[i] as string);
    // level 0 means the section's own heading is not a heading at all - an
    // explicit anchor line rather than Markdown. Then any heading closes it.
    if (candidate > 0 && (level === 0 || candidate <= level)) {
      end = i;
      break;
    }
  }
  return { startLine: index + 1, endLine: end };
}

export interface BoundsViolation {
  /** 1-based line, in the coordinates of the content being replaced. */
  readonly line: number;
  readonly reason: string;
}

/**
 * Checks that every line this write changes falls inside `range`.
 *
 * Works on the diff rather than on the whole document, because an Agent that
 * rewrites its own section will necessarily hand back the entire file: the
 * question is never "what did it send" but "what did it change".
 *
 * Insertions are charged to the line they land before, and an insertion at the
 * very end of the section is allowed - otherwise an Agent could never append to
 * its own final line, which is the most ordinary edit there is.
 */
export function findOutOfBounds(
  previousContent: string,
  nextContent: string,
  range: SectionRange,
): BoundsViolation | null {
  const before = splitLines(previousContent);
  const after = splitLines(nextContent);

  for (const hunk of diffLines(before, after)) {
    // `start` is 0-based in `before`; convert to the 1-based line it touches.
    const first = hunk.start + 1;
    const last = hunk.deleted > 0 ? hunk.start + hunk.deleted : first;

    if (hunk.deleted > 0) {
      if (first < range.startLine || last > range.endLine) {
        return {
          line: first,
          reason:
            "changes line " +
            first +
            (last !== first ? "-" + last : "") +
            ", outside lines " +
            range.startLine +
            "-" +
            range.endLine,
        };
      }
      continue;
    }

    // A pure insertion. It lands *before* `first`, so the boundary that matters
    // is the section's closing line plus one.
    if (first < range.startLine || first > range.endLine + 1) {
      return {
        line: first,
        reason:
          "inserts at line " +
          first +
          ", outside lines " +
          range.startLine +
          "-" +
          range.endLine,
      };
    }
  }
  return null;
}

/** Tracks which Agent owns which section, per document. */
export class SectionRegistry {
  private readonly byDoc = new Map<string, Map<string, string>>();

  allocate(docId: string, agentId: string, heading: string): SectionAllocation {
    let onDoc = this.byDoc.get(docId);
    if (!onDoc) {
      onDoc = new Map();
      this.byDoc.set(docId, onDoc);
    }
    onDoc.set(agentId, heading.trim());
    return { docId, agentId, heading: heading.trim() };
  }

  /** True when this document allocates sections at all. */
  isAllocated(docId: string): boolean {
    return (this.byDoc.get(docId)?.size ?? 0) > 0;
  }

  headingFor(docId: string, agentId: string): string | null {
    return this.byDoc.get(docId)?.get(agentId) ?? null;
  }

  listFor(docId: string): SectionAllocation[] {
    const onDoc = this.byDoc.get(docId);
    if (!onDoc) return [];
    return [...onDoc].map(([agentId, heading]) => ({ docId, agentId, heading }));
  }

  all(): SectionAllocation[] {
    return [...this.byDoc].flatMap(([docId, onDoc]) =>
      [...onDoc].map(([agentId, heading]) => ({ docId, agentId, heading })),
    );
  }

  release(docId: string): void {
    this.byDoc.delete(docId);
  }

  /** For persistence. */
  snapshot(): SectionAllocation[] {
    return this.all();
  }

  restore(allocations: readonly SectionAllocation[]): void {
    for (const entry of allocations) {
      this.allocate(entry.docId, entry.agentId, entry.heading);
    }
  }
}
