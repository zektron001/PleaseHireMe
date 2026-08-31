import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../errors.js";
import { splitLines } from "../concord/merge.js";
import { responsibleAgents } from "../concord/provenance.js";
import type { SharedDocStore } from "../concord/store.js";
import type {
  AgentRouting,
  CommentStatus,
  ReiterationRun,
  ReiterationStatus,
  ReviewComment,
  ReviewEvent,
} from "./types.js";

const MAX_BODY = 2_000;
const MAX_COMMENTS_PER_RUN = 10;

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Lines [start, end] of `content`, 1-based inclusive. */
export function sliceLines(content: string, start: number, end: number): string {
  return splitLines(content).slice(start - 1, end).join("\n");
}

export interface ReviewStoreOptions {
  /** Where to persist review state. Omitted in tests: memory only. */
  readonly persistPath?: string | undefined;
  /**
   * Re-iterations an Agent-authored comment may spend before it is handed to a
   * human. Never applies to a human's own comment - a human decides for
   * themselves when they have asked enough times.
   */
  readonly maxAgentRounds?: number | undefined;
}

const DEFAULT_MAX_AGENT_ROUNDS = 3;

interface PersistedReview {
  /** 1 predates Agent-authored comments; see initialize() for the upgrade. */
  readonly version: 1 | 2;
  readonly comments: readonly ReviewComment[];
  readonly runs: readonly ReiterationRun[];
  readonly events: readonly ReviewEvent[];
}

export interface CreateCommentInput {
  readonly docId: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly body: string;
  /**
   * The accountable human: the session holder, or - when an Agent raised this -
   * that Agent's owner, resolved by the caller. ReviewService holds no
   * orchestrator, deliberately, so it cannot look an owner up itself.
   */
  readonly humanId: string;
  /** Set when an Agent raised this rather than a human. */
  readonly agentId?: string | undefined;
  /** Rounds already spent by the comment this answers, so a reply inherits it. */
  readonly rounds?: number | undefined;
  /** An explicit human choice, required when provenance is ambiguous. */
  readonly targetAgentId?: string | undefined;
}

/**
 * Review state: comments, their routing, and the re-iteration runs they drive.
 *
 * Two rules do the load-bearing work here.
 *
 *   The anchor is derived, never supplied. selectedText and its hash are read
 *   from canonical content at creation. A browser cannot claim a comment refers
 *   to code that was never there.
 *   A stale comment is never sent to an Agent. If the anchored lines changed
 *   after the comment was written, the comment is marked stale and held. The
 *   alternative - guessing a new location - would send an Agent feedback about
 *   code that no longer exists.
 */
export class ReviewService {
  private readonly comments = new Map<string, ReviewComment>();
  private readonly runs = new Map<string, ReiterationRun>();
  private readonly events: ReviewEvent[] = [];
  private sequence = 0;

  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly docs: SharedDocStore,
    private readonly now: () => number = Date.now,
    private readonly options: ReviewStoreOptions = {},
  ) {}

  /**
   * Restores review state. A review conversation that vanishes when the server
   * restarts is not a review conversation, and the comments carry the only
   * record of what a human asked for.
   */
  async initialize(): Promise<void> {
    const file = this.options.persistPath;
    if (!file) return;
    await mkdir(path.dirname(file), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = JSON.parse(raw) as PersistedReview;
    if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.comments)) {
      throw new Error("Unsupported review state format");
    }
    for (const comment of parsed.comments) {
      // The read path IS the migration, which is the only kind that cannot be
      // forgotten. A v1 file predates Agent-authored comments, so every comment
      // in it was written by a human, has spent no rounds, and has no Agent
      // agreement recorded. Defaults first so a v2 file's real values win.
      this.comments.set(comment.id, {
        createdByAgentId: null,
        rounds: 0,
        agentResolved: [],
        ...structuredClone(comment),
      });
    }
    for (const run of parsed.runs ?? []) this.runs.set(run.id, structuredClone(run));
    this.events.push(...(parsed.events ?? []).map((event) => structuredClone(event)));
    this.sequence = this.events.reduce(
      (max, event) => Math.max(max, event.sequence),
      0,
    );
  }

  /** Atomic replace, the same shape CONCORD uses for documents. */
  private persist(): Promise<void> {
    const file = this.options.persistPath;
    if (!file) return Promise.resolve();
    const payload: PersistedReview = {
      version: 2,
      comments: [...this.comments.values()],
      runs: [...this.runs.values()],
      events: this.events,
    };
    const operation = this.persistQueue.then(async () => {
      const temporary = file + ".tmp";
      await writeFile(temporary, JSON.stringify(payload, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, file);
    });
    this.persistQueue = operation.catch(() => undefined);
    return operation;
  }

  /** Awaits any queued write. Tests and shutdown use this. */
  flush(): Promise<void> {
    return this.persistQueue;
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private append(
    docId: string,
    actorType: ReviewEvent["actorType"],
    actorId: string,
    type: ReviewEvent["type"],
    summary: string,
  ): void {
    this.sequence += 1;
    this.events.push({
      id: randomUUID(),
      sequence: this.sequence,
      docId,
      actorType,
      actorId,
      type,
      summary,
      createdAt: this.stamp(),
    });
  }

  /**
   * Which Agent owns a line range, from CONCORD provenance.
   *
   * Read through the store's authorized history path first, so a caller cannot
   * learn attribution for a document its warrant does not cover.
   */
  routeFor(docId: string, agentId: string, startLine: number, endLine: number): AgentRouting {
    const gate = this.docs.readHistory(docId, agentId);
    if (gate.status === "denied") throw new HttpError(403, gate.reason);
    if (gate.status === "missing") throw new HttpError(404, "Document not found");
    return responsibleAgents(this.docs.provenanceOf(docId), startLine, endLine);
  }

  createComment(input: CreateCommentInput): ReviewComment {
    const body = input.body.trim();
    if (!body) throw new HttpError(400, "A comment needs a body");
    if (body.length > MAX_BODY) {
      throw new HttpError(400, "Comment exceeds " + MAX_BODY + " characters");
    }

    const doc = this.docs.snapshot(input.docId);
    if (!doc) throw new HttpError(404, "Document not found");

    const lines = splitLines(doc.content);
    if (
      !Number.isInteger(input.startLine) ||
      !Number.isInteger(input.endLine) ||
      input.startLine < 1 ||
      input.endLine < input.startLine ||
      input.endLine > lines.length
    ) {
      throw new HttpError(
        400,
        "Line range is outside the document (1-" + lines.length + ")",
      );
    }

    // Derived here, on the server, from canonical content.
    const selectedText = sliceLines(doc.content, input.startLine, input.endLine);
    const routing = responsibleAgents(
      this.docs.provenanceOf(input.docId),
      input.startLine,
      input.endLine,
    );

    const chosen = input.targetAgentId ?? routing.recommendedAgentId;
    if (!chosen) {
      throw new HttpError(
        409,
        routing.ambiguous
          ? "Several Agents changed these lines; choose one explicitly"
          : "No Agent has changed these lines; choose one explicitly",
      );
    }
    // An explicit override must still be an Agent that actually touched the
    // range, unless nothing did. Otherwise a caller could aim feedback at any
    // Agent it liked.
    if (
      input.targetAgentId &&
      routing.candidateAgentIds.length > 0 &&
      !routing.candidateAgentIds.includes(input.targetAgentId)
    ) {
      throw new HttpError(
        400,
        "That Agent did not write the selected lines",
      );
    }

    // An Agent commenting on lines it wrote itself would be routed straight
    // back to itself: a thread with no peer in it, which the rounds cap would
    // only stop after burning three real runs. Provenance cannot catch this,
    // because "who wrote these lines" is the right answer to the wrong question.
    if (input.agentId && input.agentId === chosen) {
      throw new HttpError(409, "An Agent cannot review its own lines");
    }

    const at = this.stamp();
    const comment: ReviewComment = {
      id: randomUUID(),
      docId: input.docId,
      baseVersion: doc.version,
      startLine: input.startLine,
      endLine: input.endLine,
      selectedText,
      selectedTextHash: hashText(selectedText),
      body,
      responsibleAgentId: chosen,
      createdByHumanId: input.humanId,
      createdByAgentId: input.agentId ?? null,
      rounds: input.rounds ?? 0,
      agentResolved: [],
      status: "open",
      lastReiterationRunId: null,
      createdAt: at,
      updatedAt: at,
    };
    this.comments.set(comment.id, comment);
    void this.persist();
    this.append(
      input.docId,
      input.agentId ? "agent" : "human",
      input.agentId ?? input.humanId,
      "comment.created",
      "Comment on lines " +
        input.startLine +
        "-" +
        input.endLine +
        " routed to " +
        chosen,
    );
    return structuredClone(comment);
  }

  get(commentId: string): ReviewComment {
    const comment = this.comments.get(commentId);
    if (!comment) throw new HttpError(404, "Comment not found");
    return comment;
  }

  listComments(docId: string): ReviewComment[] {
    return structuredClone(
      [...this.comments.values()].filter((comment) => comment.docId === docId),
    );
  }

  /**
   * Every comment, across documents. Used by the live board, which is scoped by
   * its caller to the Agents the viewer holds - so this stays unscoped on
   * purpose rather than growing a second, weaker notion of visibility.
   */
  listAllComments(): ReviewComment[] {
    return structuredClone([...this.comments.values()]);
  }

  listRuns(docId: string): ReiterationRun[] {
    return structuredClone(
      [...this.runs.values()].filter((run) => run.docId === docId),
    );
  }

  listEvents(docId: string, limit = 100): ReviewEvent[] {
    return structuredClone(
      this.events.filter((event) => event.docId === docId).slice(-limit).reverse(),
    );
  }

  /**
   * True when the anchored lines still hold the text the comment was written
   * about. Re-checked immediately before an Agent is asked to act on it.
   */
  isAnchorIntact(comment: ReviewComment): boolean {
    const doc = this.docs.snapshot(comment.docId);
    if (!doc) return false;
    const lines = splitLines(doc.content);
    if (comment.endLine > lines.length) return false;
    const current = sliceLines(doc.content, comment.startLine, comment.endLine);
    return hashText(current) === comment.selectedTextHash;
  }

  /**
   * The anchored lines moved, so the comment is held rather than sent.
   *
   * Agent-authored comments are held as `blocked`, not `stale`, and the
   * difference is not cosmetic: the Review panel filters `stale` out of the
   * open list, which is right for a human's own comment - they wrote it, they
   * can see it went stale, they can write another. Nobody is watching on an
   * Agent's behalf, so a stale Agent comment marked `stale` would vanish with
   * no human ever learning a peer raised something.
   */
  markStale(comment: ReviewComment): ReviewComment {
    return this.setStatus(comment.id, comment.createdByAgentId ? "blocked" : "stale");
  }

  /**
   * An Agent records that it considers a comment settled.
   *
   * THE DEPARTURE lives on this method, and only here. The standing rule is
   * that comments become `addressed`, never `resolved`, because "an Agent
   * producing a patch is not a human agreeing the point was handled". That rule
   * protects a HUMAN's judgement about their own feedback, and for a human's
   * comment it is untouched below.
   *
   * When both parties are Agents there is no human judgement to short-circuit:
   * nobody wrote the point who could agree it was met. So the two Agents
   * settling it is the whole of the agreement - and it takes BOTH, because one
   * Agent declaring its own work acceptable is exactly the thing the original
   * rule refuses.
   */
  agentResolve(commentId: string, agentId: string): ReviewComment {
    const comment = this.get(commentId);
    if (!comment.createdByAgentId) {
      throw new HttpError(403, "Only a human resolves a human's comment");
    }
    if (agentId !== comment.createdByAgentId && agentId !== comment.responsibleAgentId) {
      throw new HttpError(403, "That Agent is not party to this comment");
    }

    const stored = this.comments.get(commentId) as ReviewComment;
    if (!stored.agentResolved.includes(agentId)) stored.agentResolved.push(agentId);
    stored.updatedAt = this.stamp();

    const mutual =
      stored.agentResolved.includes(stored.createdByAgentId as string) &&
      stored.agentResolved.includes(stored.responsibleAgentId);
    const result = mutual
      ? this.setStatus(commentId, "resolved")
      : structuredClone(stored);

    void this.persist();
    this.append(
      stored.docId,
      "agent",
      agentId,
      "comment.resolved",
      mutual
        ? "Both Agents settled the comment on lines " +
          stored.startLine + "-" + stored.endLine
        : "Agreed the comment on lines " +
          stored.startLine + "-" + stored.endLine + " is settled",
    );
    return result;
  }

  setStatus(commentId: string, status: CommentStatus): ReviewComment {
    const comment = this.comments.get(commentId);
    if (!comment) throw new HttpError(404, "Comment not found");
    comment.status = status;
    comment.updatedAt = this.stamp();
    void this.persist();
    if (status === "stale") {
      this.append(
        comment.docId,
        "system",
        "CONCORD",
        "comment.stale",
        "Lines " +
          comment.startLine +
          "-" +
          comment.endLine +
          " changed; the comment is held rather than sent to an Agent",
      );
    }
    return structuredClone(comment);
  }

  resolve(commentId: string, humanId: string): ReviewComment {
    const comment = this.get(commentId);
    const resolved = this.setStatus(commentId, "resolved");
    this.append(
      comment.docId,
      "human",
      humanId,
      "comment.resolved",
      "Resolved the comment on lines " + comment.startLine + "-" + comment.endLine,
    );
    return resolved;
  }

  /**
   * Groups comments into at most one run per (document, Agent).
   *
   * Comments aimed at different Agents become separate runs so those Agents can
   * proceed independently - the parallelism the whole platform is about.
   */
  /**
   * @param ownsAgent Whether this human owns an Agent. Passed in rather than
   *   looked up: ReviewService holds no orchestrator, and taking the predicate
   *   as an argument means the check below cannot be skipped by a caller who
   *   forgets to pair this with the route's own ownership check.
   */
  planRuns(
    commentIds: readonly string[],
    humanId: string,
    ownsAgent: (agentId: string) => boolean = () => false,
  ): { docId: string; agentId: string; comments: ReviewComment[] }[] {
    if (commentIds.length === 0) throw new HttpError(400, "No comments selected");
    const groups = new Map<string, { docId: string; agentId: string; comments: ReviewComment[] }>();
    for (const id of commentIds) {
      const comment = this.get(id);
      // Feedback a HUMAN wrote stays that human's to dispatch, unchanged.
      //
      // Feedback an AGENT raised is nobody's property: no human wrote it, so
      // asking whether this human authored it is the wrong question rather than
      // a weaker version of the right one. The human entitled to spend an Agent
      // on it is the one who owns the Agent being ASKED - they answer for the
      // run it starts.
      const ownsRecipient =
        comment.createdByAgentId !== null && ownsAgent(comment.responsibleAgentId);
      if (comment.createdByHumanId !== humanId && !ownsRecipient) {
        throw new HttpError(403, "That comment belongs to another reviewer");
      }
      if (comment.status === "resolved") {
        throw new HttpError(409, "A resolved comment cannot be re-iterated");
      }
      if (!this.isAnchorIntact(comment)) {
        this.markStale(comment);
        throw new HttpError(
          409,
          "Comment " + comment.id + " is stale; select the updated code again",
        );
      }
      const key = comment.docId + "::" + comment.responsibleAgentId;
      const group =
        groups.get(key) ??
        { docId: comment.docId, agentId: comment.responsibleAgentId, comments: [] };
      group.comments.push(comment);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.comments.length > MAX_COMMENTS_PER_RUN) {
        throw new HttpError(
          400,
          "At most " + MAX_COMMENTS_PER_RUN + " comments per Agent per run",
        );
      }
    }
    return [...groups.values()];
  }

  openRun(
    docId: string,
    agentId: string,
    humanId: string,
    comments: readonly ReviewComment[],
    baseVersion: number,
  ): ReiterationRun {
    const run: ReiterationRun = {
      id: randomUUID(),
      docId,
      agentId,
      humanId,
      commentIds: comments.map((comment) => comment.id),
      baseVersion,
      status: "queued",
      resultingVersion: null,
      error: null,
      createdAt: this.stamp(),
      completedAt: null,
    };
    this.runs.set(run.id, run);
    void this.persist();
    for (const comment of comments) {
      const stored = this.comments.get(comment.id);
      if (stored) {
        stored.status = "in_progress";
        stored.lastReiterationRunId = run.id;
        stored.updatedAt = run.createdAt;
      }
    }
    this.append(
      docId,
      "human",
      humanId,
      "reiteration.started",
      "Sent " + comments.length + " comment(s) to " + agentId,
    );
    return structuredClone(run);
  }

  /**
   * Where an Agent-authored comment stops being the Agents' problem.
   *
   * A human's comment is never escalated: they can see the outcome and decide
   * for themselves whether to ask again. An Agent-authored one has nobody
   * watching it, so every way a round can end badly has to route to a human
   * rather than sit at a status that reads like progress.
   */
  private escalate(
    comment: ReviewComment,
    outcome: CommentStatus,
    maxRounds: number,
  ): CommentStatus {
    if (!comment.createdByAgentId) return outcome;
    // CONCORD refused it, or the run died - including every AEGIS refusal,
    // which arrives here as `failed`. Neither is something a retry fixes.
    if (outcome === "conflict" || outcome === "failed") return "blocked";
    // The revision landed, but the two Agents have not both called it settled
    // and the budget is gone. That is a disagreement, and it is a human's.
    if (comment.rounds >= maxRounds && outcome !== "resolved") return "blocked";
    return outcome;
  }

  /**
   * Records what CONCORD decided about the Agent's revision.
   *
   * Comments become "addressed", never "resolved": an Agent producing a patch
   * is not the same as a human agreeing the point was handled. The one
   * exception is an Agent-to-Agent thread, where both ends must agree - see
   * `agentResolve`, which is the only place that writes "resolved" for one.
   */
  closeRun(
    runId: string,
    status: ReiterationStatus,
    resultingVersion: number | null,
    error: string | null,
  ): ReiterationRun {
    const run = this.runs.get(runId);
    if (!run) throw new HttpError(404, "Re-iteration run not found");
    run.status = status;
    run.resultingVersion = resultingVersion;
    run.error = error ? error.slice(0, 300) : null;
    run.completedAt = this.stamp();

    const commentStatus: CommentStatus =
      status === "written" || status === "merged"
        ? "addressed"
        : status === "conflict"
          ? "conflict"
          : status === "no_change"
            ? "open"
            : "failed";
    const maxRounds = this.options.maxAgentRounds ?? DEFAULT_MAX_AGENT_ROUNDS;
    for (const id of run.commentIds) {
      const comment = this.comments.get(id);
      if (comment) {
        // Counted on CLOSE, not on open: a run that never completed did not
        // spend a round. The cost is that a crash loop never advances the
        // counter - but a crash loop lands on `failed`, which escalates below
        // anyway, so nothing rides on the counter to stop it.
        comment.rounds += 1;
        comment.status = this.escalate(comment, commentStatus, maxRounds);
        comment.updatedAt = run.completedAt;
      }
    }
    this.append(
      run.docId,
      "agent",
      run.agentId,
      status === "written" || status === "merged"
        ? "reiteration.completed"
        : "reiteration.failed",
      "Re-iteration " +
        status +
        (resultingVersion ? " at version " + resultingVersion : ""),
    );
    void this.persist();
    return structuredClone(run);
  }
}
