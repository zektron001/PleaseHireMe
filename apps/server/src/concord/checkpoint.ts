/**
 * Agent-authored checkpoints.
 *
 * CONCORD already commits an Agent's turn as one version. What it could not say
 * was WHY: the history read "agent-7 changed 4 lines", which is a diff, not a
 * commit. An Agent knows when it has finished a coherent piece of work, so it
 * is asked to name it, and that name is what appears in the log.
 *
 * One commit per turn, deliberately. Several commits inside a turn would need
 * the reconciler to observe the workspace mid-run, and CONCORD sees a turn's
 * result at the end of it by design - see reconcile.ts. Promising per-checkpoint
 * commits while only observing turn boundaries would be a claim the middleware
 * cannot keep.
 *
 * The message is untrusted text from a model: bounded, single-line, and never
 * interpreted as an instruction.
 */

const CHECKPOINT_PATTERN = /^[ \t]*CONCORD-COMMIT:[ \t]*(.+?)[ \t]*$/gim;

export const MAX_CHECKPOINT_MESSAGE = 200;

/** Appended to an Agent's task so it knows how to name its own checkpoint. */
export const CHECKPOINT_INSTRUCTION = [
  "",
  "---",
  "",
  "## Recording your checkpoint",
  "",
  "The shared files in this workspace are versioned by CONCORD. When you have",
  "finished a coherent piece of work, describe it on a single line of this exact",
  "form, as the last line of your reply:",
  "",
  "CONCORD-COMMIT: <what you changed and why, in one line>",
  "",
  "The platform commits your edits under that message and attributes the changed",
  "lines to you. Write it only once, for the work you actually completed. If you",
  "changed nothing, omit the line.",
  "",
].join("\n");

export function withCheckpointInstruction(prompt: string): string {
  return prompt + "\n" + CHECKPOINT_INSTRUCTION;
}

/**
 * Reads the Agent's checkpoint message out of its reply.
 *
 * The LAST marker wins: a model that restates its plan before doing the work
 * would otherwise have its intention recorded instead of its result.
 */
export function parseCheckpoint(output: string): string | null {
  let message: string | null = null;
  for (const match of output.matchAll(CHECKPOINT_PATTERN)) {
    const candidate = match[1]?.replace(/\s+/g, " ").trim();
    if (candidate) message = candidate;
  }
  if (!message) return null;
  return message.length > MAX_CHECKPOINT_MESSAGE
    ? message.slice(0, MAX_CHECKPOINT_MESSAGE - 1) + "…"
    : message;
}
