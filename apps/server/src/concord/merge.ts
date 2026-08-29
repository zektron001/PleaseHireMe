/**
 * Three-way line merge.
 *
 * Static path partitioning ("agent A owns limiter.ts, agent B owns config.ts")
 * avoids conflicts by forbidding the situation, which stops working the moment
 * two subtasks genuinely need the same file. This module handles the situation
 * instead: two Agents edit from the same base, and if their edits touch disjoint
 * regions the result converges automatically. If they overlap, that is a real
 * disagreement and is reported rather than silently resolved - a merge that
 * quietly picks a winner is how you lose an Agent's work without noticing.
 *
 * Line-based rather than character-based: Agents rewrite lines, they do not type
 * characters, so a CRDT's per-character metadata would cost a great deal and buy
 * nothing here. See CONCORD's limitations for when that stops being true.
 */

export interface Hunk {
  /** First line index in the base that this hunk replaces. */
  readonly start: number;
  /** How many base lines are replaced. */
  readonly deleted: number;
  /** Lines put in their place. */
  readonly inserted: readonly string[];
}

export interface MergeConflict {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly ours: readonly string[];
  readonly theirs: readonly string[];
}

export type MergeResult =
  | { readonly ok: true; readonly content: string; readonly hunks: number }
  | { readonly ok: false; readonly conflicts: readonly MergeConflict[] };

export function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

export function joinLines(lines: readonly string[]): string {
  return lines.join("\n");
}

/**
 * Longest common subsequence table over lines. O(n*m) time and space, which is
 * fine for source files and is documented as a limitation for large documents.
 */
function lcsLengths(a: readonly string[], b: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = table[i] as number[];
    const next = table[i + 1] as number[];
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  return table;
}

/** Edit hunks turning `base` into `other`, expressed in base coordinates. */
export function diffLines(
  base: readonly string[],
  other: readonly string[],
): Hunk[] {
  const table = lcsLengths(base, other);
  const hunks: Hunk[] = [];

  let i = 0;
  let j = 0;
  let pendingStart = -1;
  let deleted = 0;
  let inserted: string[] = [];

  const flush = (): void => {
    if (pendingStart === -1) return;
    hunks.push({ start: pendingStart, deleted, inserted });
    pendingStart = -1;
    deleted = 0;
    inserted = [];
  };

  while (i < base.length && j < other.length) {
    if (base[i] === other[j]) {
      flush();
      i += 1;
      j += 1;
      continue;
    }
    if (pendingStart === -1) pendingStart = i;

    const down = (table[i + 1] as number[])[j] as number;
    const right = (table[i] as number[])[j + 1] as number;
    if (down >= right) {
      deleted += 1;
      i += 1;
    } else {
      inserted.push(other[j] as string);
      j += 1;
    }
  }

  if (i < base.length || j < other.length) {
    if (pendingStart === -1) pendingStart = i;
    while (i < base.length) {
      deleted += 1;
      i += 1;
    }
    while (j < other.length) {
      inserted.push(other[j] as string);
      j += 1;
    }
  }
  flush();
  return hunks;
}

const overlaps = (a: Hunk, b: Hunk): boolean => {
  // Zero-length hunks are pure insertions; two insertions at the same point
  // are a genuine ordering disagreement, so treat them as overlapping.
  const aEnd = a.start + Math.max(a.deleted, 1);
  const bEnd = b.start + Math.max(b.deleted, 1);
  return a.start < bEnd && b.start < aEnd;
};

/**
 * Merges two independent sets of edits made against the same base.
 *
 * Disjoint edits converge. Overlapping edits are reported as conflicts with the
 * competing content, so a caller can show both sides rather than guess.
 */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs) {
    return { ok: true, content: ours, hunks: 0 };
  }
  const baseLines = splitLines(base);
  if (base === theirs) return { ok: true, content: ours, hunks: 1 };
  if (base === ours) return { ok: true, content: theirs, hunks: 1 };

  const ourHunks = diffLines(baseLines, splitLines(ours));
  const theirHunks = diffLines(baseLines, splitLines(theirs));

  const conflicts: MergeConflict[] = [];
  for (const mine of ourHunks) {
    for (const yours of theirHunks) {
      if (!overlaps(mine, yours)) continue;
      conflicts.push({
        baseStart: Math.min(mine.start, yours.start),
        baseEnd: Math.max(mine.start + mine.deleted, yours.start + yours.deleted),
        ours: mine.inserted,
        theirs: yours.inserted,
      });
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };

  // Disjoint: apply every hunk, right to left so earlier indices stay valid.
  const all = [...ourHunks, ...theirHunks].sort((x, y) => y.start - x.start);
  const merged = [...baseLines];
  for (const hunk of all) {
    merged.splice(hunk.start, hunk.deleted, ...hunk.inserted);
  }
  return { ok: true, content: joinLines(merged), hunks: all.length };
}
