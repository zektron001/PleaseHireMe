/**
 * Turns the markers an Agent emitted into review state.
 *
 * Called from the two places a turn can end - the ordinary turn in
 * warrant/routes.ts and the re-iteration in reiteration.ts - and from nowhere
 * else. There is no HTTP route behind this and there must not be: an Agent has
 * no token, `agentId` is a selector rather than a credential, and every other
 * thing an Agent "does" to shared state is likewise something the server does
 * on its behalf after the turn.
 *
 * Everything here fails SOFT. We are past the point where CONCORD has already
 * committed the Agent's work, so throwing would turn a rejected comment into a
 * failed turn and discard edits that were accepted. A marker that cannot become
 * a comment is dropped and said out loud on the activity feed instead.
 */

import { activityBus } from "../live/activity.js";
import { docResource } from "../concord/store.js";
import type { WarrantPlane } from "../warrant/index.js";
import { parseAuthored } from "./authored.js";
import type { ReviewService } from "./service.js";
import type { ReviewComment } from "./types.js";

export interface ApplyAuthoredInput {
  readonly plane: WarrantPlane;
  readonly review: ReviewService;
  readonly docId: string;
  /** The Agent whose turn this was, and so the author of any comment in it. */
  readonly agentId: string;
  readonly subtaskId: string;
  /** Raw model output. Untrusted; only the marker lines are read. */
  readonly output: string;
  /**
   * The comments this turn was answering, in the order the prompt numbered
   * them, so `CONCORD-RESOLVE: 2` resolves the second one. Empty for an
   * ordinary work turn, where no ordinal can mean anything.
   */
  readonly answering?: readonly ReviewComment[] | undefined;
  /** Which kind of turn this was, so the feed reads in context. */
  readonly purpose: "turn" | "reiteration";
  /** The human accountable for the turn. */
  readonly humanId: string;
}

/**
 * A dropped marker is published rather than swallowed.
 *
 * An Agent that emitted feedback and had it refused should not look identical
 * to one that stayed silent - the reviewer would have no way to tell "nothing
 * to say" from "said something the platform would not carry".
 */
function say(input: ApplyAuthoredInput, detail: string): void {
  activityBus.publish({
    kind: "blocked",
    agentId: input.agentId,
    subtaskId: input.subtaskId,
    humanId: input.humanId,
    purpose: input.purpose,
    docId: input.docId,
    detail,
  });
}

export function applyAuthored(input: ApplyAuthoredInput): void {
  const { comments, resolves } = parseAuthored(input.output);
  const answering = input.answering ?? [];

  // Resolutions first, and this ordering is load-bearing: closeRun has already
  // written "addressed" over every comment in the run by the time we get here,
  // so a resolve applied before it would be silently overwritten.
  for (const resolve of resolves) {
    const target = answering[resolve.ordinal - 1];
    if (!target) {
      say(input, "Ignored CONCORD-RESOLVE for comment " + resolve.ordinal + ": no such comment");
      continue;
    }
    try {
      input.review.agentResolve(target.id, input.agentId);
    } catch (error) {
      say(input, "Could not resolve comment " + resolve.ordinal + ": " + message(error));
    }
  }

  if (comments.length === 0) return;

  // The PDP call review/routes.ts documents as impossible for a human comment
  // ("there is no Agent whose warrant the PDP could read") - here there IS one.
  // A revoked or expired warrant therefore stops an Agent commenting, and the
  // decision chain says so, without a hand-written record or a new ruleId.
  const decision = input.plane.check({
    agentId: input.agentId,
    action: "comment.write",
    resource: docResource(input.docId),
  });
  if (decision.decision !== "Allow") {
    say(input, "Review comment refused: " + decision.reason);
    return;
  }

  const subtask = input.plane.orchestrator.subtaskByAgent(input.agentId);
  if (!subtask) return;
  // A reply inherits the budget of what it answers, so opening a fresh comment
  // is not a way to start the round count over.
  const inherited = answering.reduce((most, comment) => Math.max(most, comment.rounds), 0);

  for (const authored of comments) {
    try {
      input.review.createComment({
        docId: input.docId,
        startLine: authored.startLine,
        endLine: authored.endLine,
        body: authored.body,
        humanId: subtask.ownerId,
        agentId: input.agentId,
        rounds: inherited,
      });
    } catch (error) {
      // Ambiguous provenance, a range nobody wrote, lines off the end of the
      // file, or the Agent aiming at its own work. All are ordinary refusals,
      // and all of them are the Agent's mistake rather than the platform's.
      say(
        input,
        "Dropped review comment on lines " +
          authored.startLine + "-" + authored.endLine + ": " + message(error),
      );
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
