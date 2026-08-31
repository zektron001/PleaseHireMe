/**
 * Agent-authored review comments.
 *
 * The review loop already routes a HUMAN's comment to whichever Agent last
 * changed the lines. What it could not carry was the other direction: an Agent
 * that reads a sibling's section and sees a real problem had nowhere to put it.
 * The peer strip told it who owned what and stopped there.
 *
 * This is the same shape as concord/checkpoint.ts, deliberately: an instruction
 * appended to the prompt, a single-line sentinel parsed out of the reply,
 * bounded, and never interpreted as an instruction. An Agent that already knows
 * CONCORD-COMMIT knows these.
 *
 * Two things are NOT in the markers, and both omissions are load-bearing:
 *
 *   No target Agent id. createComment resolves it from CONCORD provenance, the
 *   same way it does for a human, and refuses a range the named Agent did not
 *   write. An Agent cannot aim feedback at whoever it likes.
 *
 *   No comment id. A reply happens inside a re-iteration, whose prompt already
 *   numbers the comments it carries ("### Comment 1"), so an Agent resolves by
 *   ordinal. Every id we do not ask a model to reproduce is an id it cannot
 *   hallucinate into pointing at somebody else's comment.
 */

/** `CONCORD-REVIEW: L3-L7 the retry loop never backs off` */
const REVIEW_PATTERN =
  /^[ \t]*CONCORD-REVIEW:[ \t]*L?(\d+)[ \t]*-[ \t]*L?(\d+)[ \t]+(.+?)[ \t]*$/gim;

/** `CONCORD-RESOLVE: 1 the backoff is in and the test covers it` */
const RESOLVE_PATTERN = /^[ \t]*CONCORD-RESOLVE:[ \t]*(\d+)\b[ \t]*(.*?)[ \t]*$/gim;

/**
 * Shorter than a human's MAX_BODY of 2000. The instruction asks for one line,
 * and a cap that matches the ask is a cap the Agent can actually satisfy.
 */
export const MAX_AGENT_COMMENT_BODY = 500;

/**
 * Three per turn. An Agent with more than three genuine objections to a
 * sibling's section is describing a design disagreement, which is a human's to
 * settle - and an unbounded count is an unbounded number of runs it can start.
 */
export const MAX_AGENT_COMMENTS_PER_TURN = 3;

export interface AuthoredComment {
  readonly startLine: number;
  readonly endLine: number;
  readonly body: string;
}

export interface AuthoredResolve {
  /** 1-based position in the re-iteration prompt's comment list. */
  readonly ordinal: number;
  readonly reason: string;
}

export interface Authored {
  readonly comments: readonly AuthoredComment[];
  readonly resolves: readonly AuthoredResolve[];
}

function bound(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > MAX_AGENT_COMMENT_BODY
    ? single.slice(0, MAX_AGENT_COMMENT_BODY - 1) + "…"
    : single;
}

/**
 * Reads both markers out of an Agent's reply.
 *
 * Unlike parseCheckpoint, every match counts rather than the last: a checkpoint
 * describes one turn, but several distinct comments in one turn are legitimate.
 * A model that restates its intention before acting therefore repeats itself
 * here, so identical triples are deduped BEFORE the cap - otherwise restating
 * three times would spend the whole budget on one comment.
 *
 * Reversed ranges are normalised rather than dropped. A model writing L9-L4
 * means the same lines, and refusing it would be pedantry the reviewer pays for.
 */
export function parseAuthored(output: string): Authored {
  const seen = new Set<string>();
  const comments: AuthoredComment[] = [];
  for (const match of output.matchAll(REVIEW_PATTERN)) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const body = bound(match[3] ?? "");
    if (!body || !Number.isFinite(first) || !Number.isFinite(second)) continue;
    if (first < 1 || second < 1) continue;
    const startLine = Math.min(first, second);
    const endLine = Math.max(first, second);
    const key = startLine + ":" + endLine + ":" + body;
    if (seen.has(key)) continue;
    seen.add(key);
    if (comments.length >= MAX_AGENT_COMMENTS_PER_TURN) continue;
    comments.push({ startLine, endLine, body });
  }

  const resolved = new Set<number>();
  const resolves: AuthoredResolve[] = [];
  for (const match of output.matchAll(RESOLVE_PATTERN)) {
    const ordinal = Number(match[1]);
    if (!Number.isInteger(ordinal) || ordinal < 1) continue;
    if (resolved.has(ordinal)) continue;
    resolved.add(ordinal);
    resolves.push({ ordinal, reason: bound(match[2] ?? "") });
  }

  return { comments, resolves };
}

const REVIEW_INSTRUCTION = [
  "",
  "---",
  "",
  "## Reviewing another Agent's work",
  "",
  "You share these files with other Agents. If you see a real problem in code",
  "you did not write, say so on a single line of this exact form:",
  "",
  "CONCORD-REVIEW: L<first line>-L<last line> <what is wrong, in one line>",
  "",
  "The platform routes it to whoever wrote those lines, exactly as it routes a",
  "human reviewer's comment. Comment only on lines another Agent wrote, only on",
  "problems you would want raised about your own work, and at most three times",
  "in a turn. Do not comment to agree, to summarise, or to be polite.",
  "",
].join("\n");

const RESOLVE_INSTRUCTION = [
  "",
  "## Closing the feedback you were given",
  "",
  "When a comment above has been fully addressed, say so on its own line:",
  "",
  "CONCORD-RESOLVE: <the comment's number, as headed above> <why it is settled>",
  "",
  "A comment closes only when both Agents have said that, so this records your",
  "half and nothing more. If you disagree with a comment, do NOT resolve it -",
  "leave the code alone, say why, and a human will read the disagreement.",
  "",
].join("\n");

/**
 * Appends the marker instructions.
 *
 * `resolve` is false for an ordinary work turn, where there is no numbered
 * comment list for an ordinal to refer to - telling an Agent to resolve
 * comment 1 when it was shown no comments invites it to invent one.
 */
export function withAuthoredInstruction(
  prompt: string,
  options: { readonly resolve: boolean },
): string {
  const parts = [prompt, REVIEW_INSTRUCTION];
  if (options.resolve) parts.push(RESOLVE_INSTRUCTION);
  return parts.join("\n");
}
