/**
 * CONCORD - shared concurrent state for many Agents.
 *
 * The problem: N Agents, each acting for a different human, editing a shared set
 * of documents. Two failure modes have to be closed at once.
 *
 *   Lost update   two Agents read v3, both write, one silently overwrites the
 *                 other. No error is raised and the work is simply gone.
 *   Stale authority  an Agent's warrant is revoked between the authorization
 *                 check and the write, and the write lands anyway (TOCTOU).
 *
 * Three mechanisms, in order of how much they are relied upon:
 *
 *   1. SERIALIZATION  every operation on one document runs in a promise chain,
 *      so two operations on the same document never interleave. This is the
 *      actual race-freedom guarantee; the rest is about telling callers what
 *      happened.
 *   2. OPTIMISTIC CAS  a write states the version it read. A mismatch is a
 *      conflict, returned with the current version so the caller can rebase and
 *      retry - not an overwrite.
 *   3. LEASES  optional exclusive access for a multi-step edit, with a TTL so a
 *      dead Agent cannot hold a document forever.
 *
 * The authority check runs INSIDE the critical section. Checking authority and
 * then writing as two steps is exactly the TOCTOU above.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { merge3, type MergeConflict } from "./merge.js";

export type AuthzCheck = (
  agentId: string,
  action: "workspace.read" | "workspace.write",
  resource: string,
) => { allowed: boolean; ruleId: string; reason: string; humanId: string | null };

export interface Lease {
  readonly holder: string;
  readonly humanId: string | null;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

/**
 * A same-line disagreement, kept until a human settles it.
 *
 * Returning a conflict over HTTP and forgetting it means the only record of the
 * losing edit is one API response nobody kept. The losing text is the part that
 * is actually at risk, so it is held here with the base it was written against -
 * which is what makes a later rebase possible rather than a guess.
 */
export interface PendingConflict {
  readonly id: string;
  readonly docId: string;
  readonly agentId: string;
  readonly humanId: string | null;
  readonly at: string;
  /** The version the losing Agent had read. The base for any later rebase. */
  readonly base: string;
  /** What the losing Agent tried to write. */
  readonly ours: string;
  /** What was committed instead. */
  readonly theirs: string;
  readonly atVersion: number;
  readonly conflicts: readonly MergeConflict[];
}

/** What an Agent is doing on a document right now. See `presenceOf`. */
export interface PresenceEntry {
  readonly agentId: string;
  readonly humanId: string | null;
  readonly activity: "viewing" | "editing";
  readonly at: number;
}

/**
 * One CONCORD outcome, for the audit chain.
 *
 * The authority decision behind a write already reaches the chain through the
 * PDP. What did not was the concurrency outcome - whether the edit was written,
 * rebased or refused - which is the half a reviewer actually asks about when two
 * Agents touched one file.
 */
export interface ConcordEvent {
  readonly docId: string;
  readonly actorId: string;
  readonly humanId: string | null;
  readonly outcome: string;
  readonly version: number;
  readonly detail: Record<string, unknown>;
}

export interface SharedDoc {
  readonly id: string;
  version: number;
  content: string;
  updatedAt: string;
  updatedBy: string | null;
  lease: Lease | null;
  history: { version: number; agentId: string; humanId: string | null; at: string }[];
  conflicts: PendingConflict[];
}

export type WriteOutcome =
  | { readonly status: "written"; readonly version: number; readonly content: string }
  | { readonly status: "merged"; readonly version: number; readonly content: string; readonly hunks: number }
  | {
      readonly status: "conflict";
      readonly version: number;
      readonly content: string;
      readonly conflicts: readonly MergeConflict[];
      readonly conflictId: string;
    }
  | { readonly status: "denied"; readonly ruleId: string; readonly reason: string }
  | { readonly status: "leased"; readonly holder: string; readonly expiresAt: number };

export type ResolveOutcome =
  | { readonly status: "resolved"; readonly version: number; readonly content: string }
  | {
      readonly status: "conflict";
      readonly version: number;
      readonly content: string;
      readonly conflicts: readonly MergeConflict[];
      readonly conflictId: string;
    }
  | { readonly status: "denied"; readonly ruleId: string; readonly reason: string }
  | { readonly status: "not-found" };

export type ReleaseOutcome =
  | { readonly status: "released" }
  | { readonly status: "denied"; readonly ruleId: string; readonly reason: string }
  | { readonly status: "not-holder"; readonly holder: string | null };

export interface ReadOutcome {
  readonly status: "ok" | "denied";
  readonly version: number;
  readonly content: string;
  readonly ruleId?: string;
  readonly reason?: string;
}

/**
 * "Keep both", done in place: the committed text, with the losing Agent's
 * version of each contested range inserted directly after the winning one.
 *
 * The naive reading of "both" - one document after the other - duplicates every
 * line the two versions already agreed on, which is nearly all of them. Only the
 * contested ranges are actually in dispute, so only those are doubled.
 */
export function keepBoth(conflict: {
  theirs: string;
  conflicts: readonly MergeConflict[];
}): string {
  const lines = conflict.theirs.length === 0 ? [] : conflict.theirs.split("\n");
  const additions = new Map<number, string[]>();

  for (const range of conflict.conflicts) {
    // Locate the winning side's lines in the committed text and add ours after
    // them. Falling back to the end keeps a conflict that has since moved from
    // silently dropping the losing edit.
    const at = findRun(lines, range.theirs);
    const anchor = at === -1 ? lines.length : at + range.theirs.length;
    additions.set(anchor, [...(additions.get(anchor) ?? []), ...range.ours]);
  }

  const out: string[] = [];
  for (let index = 0; index <= lines.length; index += 1) {
    for (const added of additions.get(index) ?? []) out.push(added);
    if (index < lines.length) out.push(lines[index] as string);
  }
  return out.join("\n");
}

/** Index of the first occurrence of `needle` as consecutive lines, or -1. */
function findRun(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return -1;
  for (let index = 0; index + needle.length <= haystack.length; index += 1) {
    if (needle.every((line, offset) => haystack[index + offset] === line)) return index;
  }
  return -1;
}

export const DEFAULT_LEASE_MS = 30_000;
/** How long an Agent counts as present on a document after its last operation. */
export const PRESENCE_TTL_MS = 15_000;

/**
 * A shared document IS a repo file. Mapping it onto the existing `repo:`
 * resource space means warrants cover documents through the same rules that
 * cover files - no second authorization model, and `covers()` prefix matching
 * works unchanged.
 */
export function docResource(docId: string): string {
  return "repo:" + docId.replace(/^\/+/, "");
}

interface PersistedShape {
  readonly version: 1;
  readonly docs: readonly Omit<SharedDoc, "lease">[];
  readonly bases: readonly (readonly [string, string])[];
}

export interface StoreOptions {
  /** Where to persist documents. Omitted in tests and the demo: memory only. */
  readonly persistPath?: string | undefined;
  /** Called with every CONCORD outcome, for the audit chain. */
  readonly onEvent?: ((event: ConcordEvent) => void) | undefined;
}

export class SharedDocStore {
  private readonly docs = new Map<string, SharedDoc>();
  /** One promise chain per document id. This is what makes operations atomic. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Base content each Agent last read, for three-way merge on write. */
  private readonly bases = new Map<string, string>();
  /** docId -> agentId -> last seen. Expired entries are dropped on read. */
  private readonly presence = new Map<string, Map<string, PresenceEntry>>();
  private persistQueue: Promise<void> = Promise.resolve();
  private conflictSeq = 0;

  constructor(
    private readonly authorize: AuthzCheck,
    private readonly now: () => number = Date.now,
    private readonly options: StoreOptions = {},
  ) {}

  /**
   * Loads persisted documents. Leases are deliberately NOT persisted: a lease is
   * a claim by a live process, and a process that died holding one should not
   * keep a document locked past its own lifetime.
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
    const parsed = JSON.parse(raw) as PersistedShape;
    if (parsed.version !== 1 || !Array.isArray(parsed.docs)) {
      throw new Error("Unsupported CONCORD document format");
    }
    for (const doc of parsed.docs) {
      const restored = structuredClone(doc) as Omit<SharedDoc, "lease">;
      this.docs.set(doc.id, {
        ...restored,
        conflicts: restored.conflicts ?? [],
        lease: null,
      });
    }
    for (const [key, content] of parsed.bases ?? []) this.bases.set(key, content);
    this.conflictSeq = [...this.docs.values()].reduce(
      (max, doc) => Math.max(max, doc.conflicts.length),
      0,
    );
  }

  /**
   * Atomic replace, the same shape as the baseline JsonStore: write a temporary
   * file and rename over the target, so a crash mid-write cannot truncate the
   * documents. Queued, so two commits cannot interleave their writes.
   */
  private persist(): Promise<void> {
    const file = this.options.persistPath;
    if (!file) return Promise.resolve();
    const payload: PersistedShape = {
      version: 1,
      docs: [...this.docs.values()].map((doc) => {
        const { lease: _lease, ...rest } = structuredClone(doc);
        return rest;
      }),
      bases: [...this.bases.entries()],
    };
    const operation = this.persistQueue.then(async () => {
      const temporaryPath = file + ".tmp";
      await writeFile(temporaryPath, JSON.stringify(payload, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, file);
    });
    this.persistQueue = operation.catch(() => undefined);
    return operation;
  }

  private emit(event: ConcordEvent): void {
    this.options.onEvent?.(event);
  }

  private mark(
    docId: string,
    agentId: string,
    humanId: string | null,
    activity: PresenceEntry["activity"],
  ): void {
    let onDoc = this.presence.get(docId);
    if (!onDoc) {
      onDoc = new Map();
      this.presence.set(docId, onDoc);
    }
    // Reading is also what polling for presence does, so a live editor must not
    // be demoted to a viewer just because something asked who was here. Within
    // the TTL, editing is the stronger claim and only the timestamp refreshes.
    const current = onDoc.get(agentId);
    const editing =
      activity === "editing" ||
      (current?.activity === "editing" && current.at > this.now() - PRESENCE_TTL_MS);
    onDoc.set(agentId, {
      agentId,
      humanId,
      activity: editing ? "editing" : "viewing",
      at: this.now(),
    });
  }

  private livePresence(docId: string): PresenceEntry[] {
    const cutoff = this.now() - PRESENCE_TTL_MS;
    const onDoc = this.presence.get(docId);
    if (!onDoc) return [];
    for (const [key, entry] of onDoc) {
      if (entry.at <= cutoff) onDoc.delete(key);
    }
    return [...onDoc.values()].sort((a, b) => b.at - a.at);
  }

  /**
   * Runs `op` after every previously queued operation on the same document.
   * A rejected predecessor must not stall the chain, hence the catch.
   */
  private serialize<T>(docId: string, op: () => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(docId) ?? Promise.resolve();
    const next = previous.then(op, op);
    this.queues.set(
      docId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private ensure(docId: string): SharedDoc {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = {
        id: docId,
        version: 0,
        content: "",
        updatedAt: new Date(this.now()).toISOString(),
        updatedBy: null,
        lease: null,
        history: [],
        conflicts: [],
      };
      this.docs.set(docId, doc);
    }
    return doc;
  }

  /** Expires a lease in place. Called at the top of every critical section. */
  private reapLease(doc: SharedDoc): void {
    if (doc.lease && doc.lease.expiresAt <= this.now()) {
      doc.lease = null;
    }
  }

  private baseKey(docId: string, agentId: string): string {
    return agentId + "\u0000" + docId;
  }

  read(docId: string, agentId: string): Promise<ReadOutcome> {
    return this.serialize(docId, async () => {
      const verdict = this.authorize(agentId, "workspace.read", docResource(docId));
      if (!verdict.allowed) {
        return {
          status: "denied" as const,
          version: -1,
          content: "",
          ruleId: verdict.ruleId,
          reason: verdict.reason,
        };
      }
      const doc = this.ensure(docId);
      this.reapLease(doc);
      // Remember what this Agent saw, so a later write can be merged against it.
      const key = this.baseKey(docId, agentId);
      const moved = this.bases.get(key) !== doc.content;
      this.bases.set(key, doc.content);
      // Only when the base actually moved: a poll of an unchanged document is
      // then free, while a real checkout is durable across a restart.
      if (moved) await this.persist();
      this.mark(docId, agentId, verdict.humanId, "viewing");
      return { status: "ok" as const, version: doc.version, content: doc.content };
    });
  }

  /**
   * Compare-and-swap write with automatic three-way merge.
   *
   * `expectedVersion` is the version the Agent read. If the document has moved
   * on, the write is NOT rejected outright: the store attempts to merge the
   * Agent's edit with whatever landed in between, and only reports a conflict
   * when the two genuinely touch the same lines.
   */
  write(
    docId: string,
    agentId: string,
    expectedVersion: number,
    content: string,
  ): Promise<WriteOutcome> {
    return this.serialize(docId, async () => {
      // Authority is checked here, inside the critical section, so a revocation
      // that lands between read and write is honoured.
      const verdict = this.authorize(agentId, "workspace.write", docResource(docId));
      if (!verdict.allowed) {
        this.emit({
          docId,
          actorId: agentId,
          humanId: verdict.humanId,
          outcome: "denied",
          version: this.docs.get(docId)?.version ?? 0,
          detail: { ruleId: verdict.ruleId, reason: verdict.reason },
        });
        return {
          status: "denied" as const,
          ruleId: verdict.ruleId,
          reason: verdict.reason,
        };
      }

      const doc = this.ensure(docId);
      this.reapLease(doc);
      this.mark(docId, agentId, verdict.humanId, "editing");

      if (doc.lease && doc.lease.holder !== agentId) {
        this.emit({
          docId,
          actorId: agentId,
          humanId: verdict.humanId,
          outcome: "leased",
          version: doc.version,
          detail: { holder: doc.lease.holder },
        });
        return {
          status: "leased" as const,
          holder: doc.lease.holder,
          expiresAt: doc.lease.expiresAt,
        };
      }

      const commit = (next: string): { version: number; content: string } => {
        doc.content = next;
        doc.version += 1;
        doc.updatedAt = new Date(this.now()).toISOString();
        doc.updatedBy = agentId;
        doc.history.push({
          version: doc.version,
          agentId,
          humanId: verdict.humanId,
          at: doc.updatedAt,
        });
        this.bases.set(this.baseKey(docId, agentId), next);
        return { version: doc.version, content: next };
      };

      if (expectedVersion === doc.version) {
        const result = commit(content);
        await this.persist();
        this.emit({
          docId,
          actorId: agentId,
          humanId: verdict.humanId,
          outcome: "written",
          version: result.version,
          detail: {},
        });
        return { status: "written" as const, ...result };
      }

      // The document moved. Merge this Agent's edit against the version it read.
      const base = this.bases.get(this.baseKey(docId, agentId)) ?? "";
      const merged = merge3(base, content, doc.content);
      if (merged.ok) {
        const result = commit(merged.content);
        await this.persist();
        this.emit({
          docId,
          actorId: agentId,
          humanId: verdict.humanId,
          outcome: "merged",
          version: result.version,
          detail: { hunks: merged.hunks, rebasedOnto: expectedVersion },
        });
        return { status: "merged" as const, ...result, hunks: merged.hunks };
      }

      const pending: PendingConflict = {
        id: "cf" + ++this.conflictSeq + "_" + docId.replace(/[^a-zA-Z0-9]+/g, "-"),
        docId,
        agentId,
        humanId: verdict.humanId,
        at: new Date(this.now()).toISOString(),
        base,
        ours: content,
        theirs: doc.content,
        atVersion: doc.version,
        conflicts: merged.conflicts,
      };
      // One open conflict per Agent per document: a retry supersedes rather than
      // piles up, so a human is never asked to settle the same edit twice.
      doc.conflicts = doc.conflicts.filter((item) => item.agentId !== agentId);
      doc.conflicts.push(pending);
      await this.persist();
      this.emit({
        docId,
        actorId: agentId,
        humanId: verdict.humanId,
        outcome: "conflict",
        version: doc.version,
        detail: { conflictId: pending.id, lines: merged.conflicts.length },
      });
      return {
        status: "conflict" as const,
        version: doc.version,
        content: doc.content,
        conflicts: merged.conflicts,
        conflictId: pending.id,
      };
    });
  }

  /**
   * Settles a conflict the way C5 said it should be settled: both sides were
   * kept, and the human who owns the losing Agent chooses between them.
   *
   * The rebase base is `theirs` - what was committed at the moment of the
   * conflict - and NOT the original base. The human's choice is precisely the
   * answer to "base -> ours vs theirs", so rebasing it against the original base
   * would re-derive the same contested lines and refuse the decision that was
   * just made. Rebasing from `theirs` instead means the decision wins on the
   * contested lines while anything that landed elsewhere since is still merged
   * rather than clobbered - so a third Agent's untouched work survives.
   */
  resolve(
    docId: string,
    conflictId: string,
    humanId: string,
    isOrchestrator: boolean,
    chosen: string,
  ): Promise<ResolveOutcome> {
    return this.serialize(docId, async () => {
      const doc = this.docs.get(docId);
      const pending = doc?.conflicts.find((item) => item.id === conflictId);
      if (!doc || !pending) return { status: "not-found" as const };

      // Identity comes from the session, never from the request body. The human
      // who owns the losing edit settles it; the orchestrator may settle any.
      if (!isOrchestrator && pending.humanId !== humanId) {
        return {
          status: "denied" as const,
          ruleId: "WB-6.cross-owner",
          reason:
            "Only " + (pending.humanId ?? "the owning human") + " may resolve this conflict",
        };
      }

      const merged = merge3(pending.theirs, chosen, doc.content);
      if (!merged.ok) {
        const next: PendingConflict = {
          ...pending,
          ours: chosen,
          theirs: doc.content,
          atVersion: doc.version,
          at: new Date(this.now()).toISOString(),
          conflicts: merged.conflicts,
        };
        doc.conflicts = doc.conflicts.map((item) => (item.id === conflictId ? next : item));
        await this.persist();
        return {
          status: "conflict" as const,
          version: doc.version,
          content: doc.content,
          conflicts: merged.conflicts,
          conflictId,
        };
      }

      doc.content = merged.content;
      doc.version += 1;
      doc.updatedAt = new Date(this.now()).toISOString();
      doc.updatedBy = humanId;
      doc.history.push({ version: doc.version, agentId: humanId, humanId, at: doc.updatedAt });
      doc.conflicts = doc.conflicts.filter((item) => item.id !== conflictId);
      // The Agent that lost now has the resolved text as its base, so its next
      // write rebases onto the human's decision instead of re-conflicting.
      this.bases.set(this.baseKey(docId, pending.agentId), merged.content);
      await this.persist();
      this.emit({
        docId,
        actorId: humanId,
        humanId,
        outcome: "resolved",
        version: doc.version,
        detail: { conflictId, agentId: pending.agentId },
      });
      return { status: "resolved" as const, version: doc.version, content: merged.content };
    });
  }

  acquireLease(
    docId: string,
    agentId: string,
    ttlMs = DEFAULT_LEASE_MS,
  ): Promise<
    { ok: true; lease: Lease } | { ok: false; reason: string; holder?: string }
  > {
    return this.serialize(docId, () => {
      const verdict = this.authorize(agentId, "workspace.write", docResource(docId));
      if (!verdict.allowed) return { ok: false as const, reason: verdict.reason };

      const doc = this.ensure(docId);
      this.reapLease(doc);
      if (doc.lease && doc.lease.holder !== agentId) {
        return {
          ok: false as const,
          reason: "Document is leased by another Agent",
          holder: doc.lease.holder,
        };
      }
      const lease: Lease = {
        holder: agentId,
        humanId: verdict.humanId,
        acquiredAt: this.now(),
        expiresAt: this.now() + ttlMs,
      };
      doc.lease = lease;
      this.mark(docId, agentId, verdict.humanId, "editing");
      return { ok: true as const, lease };
    });
  }

  /**
   * Releasing is a write to the lease, so it needs write authority like every
   * other mutation here. Without the check, holder equality is the only gate -
   * and a holder id is not a secret, so naming one would strip another Agent's
   * exclusive lease with no warrant at all.
   */
  releaseLease(docId: string, agentId: string): Promise<ReleaseOutcome> {
    return this.serialize(docId, () => {
      const verdict = this.authorize(agentId, "workspace.write", docResource(docId));
      if (!verdict.allowed) {
        return {
          status: "denied" as const,
          ruleId: verdict.ruleId,
          reason: verdict.reason,
        };
      }
      const doc = this.ensure(docId);
      this.reapLease(doc);
      if (doc.lease?.holder !== agentId) {
        return { status: "not-holder" as const, holder: doc.lease?.holder ?? null };
      }
      doc.lease = null;
      return { status: "released" as const };
    });
  }

  /**
   * Who is on this document right now, behind the same read authority as the
   * content. Presence names Agents and the humans behind them, so it is not
   * public metadata either.
   */
  presenceOf(
    docId: string,
    agentId: string,
  ):
    | { status: "ok"; present: PresenceEntry[] }
    | { status: "denied"; ruleId: string; reason: string } {
    const verdict = this.authorize(agentId, "workspace.read", docResource(docId));
    if (!verdict.allowed) {
      return { status: "denied", ruleId: verdict.ruleId, reason: verdict.reason };
    }
    this.mark(docId, agentId, verdict.humanId, "viewing");
    return { status: "ok", present: this.livePresence(docId) };
  }

  /**
   * The write history of one document, behind the same read authority as its
   * content. Every entry names the Agent and the human behind a version, so
   * serving this ungated leaks cross-owner activity - the metadata half of the
   * disclosure the content check already closes. Authority is checked before
   * existence, so a caller without it cannot probe which documents exist.
   */
  readHistory(
    docId: string,
    agentId: string,
  ):
    | { status: "ok"; doc: SharedDoc }
    | { status: "denied"; ruleId: string; reason: string }
    | { status: "missing" } {
    const verdict = this.authorize(agentId, "workspace.read", docResource(docId));
    if (!verdict.allowed) {
      return { status: "denied", ruleId: verdict.ruleId, reason: verdict.reason };
    }
    const doc = this.docs.get(docId);
    if (!doc) return { status: "missing" };
    return { status: "ok", doc: structuredClone(doc) };
  }

  snapshot(docId: string): SharedDoc | null {
    const doc = this.docs.get(docId);
    return doc ? structuredClone(doc) : null;
  }

  /**
   * Only the documents this Agent may read. The listing carries doc ids,
   * versions and the current lease holder, so an unscoped list is a directory
   * of other humans' work and a source of holder ids to release.
   */
  list(agentId: string): {
    id: string;
    version: number;
    leasedBy: string | null;
    writers: number;
    conflicts: number;
    present: PresenceEntry[];
    updatedAt: string;
    updatedBy: string | null;
  }[] {
    return [...this.docs.values()]
      .filter(
        (doc) => this.authorize(agentId, "workspace.read", docResource(doc.id)).allowed,
      )
      .map((doc) => ({
        id: doc.id,
        version: doc.version,
        leasedBy: doc.lease && doc.lease.expiresAt > this.now() ? doc.lease.holder : null,
        writers: new Set(doc.history.map((h) => h.agentId)).size,
        conflicts: doc.conflicts.length,
        present: this.livePresence(doc.id),
        updatedAt: doc.updatedAt,
        updatedBy: doc.updatedBy,
      }));
  }

  /** Every open conflict a human is entitled to settle. Drives the UI queue. */
  conflictsFor(humanId: string, isOrchestrator: boolean): PendingConflict[] {
    return [...this.docs.values()]
      .flatMap((doc) => doc.conflicts)
      .filter((item) => isOrchestrator || item.humanId === humanId)
      .map((item) => structuredClone(item));
  }

  /** Test and demo seam: sets initial content without an authority check. */
  seed(docId: string, content: string): void {
    const doc = this.ensure(docId);
    doc.content = content;
    doc.version = 1;
  }
}
