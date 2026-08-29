/**
 * L6 - append-only, hash-chained safety log.
 *
 *   hash_i = SHA256( hash_{i-1} || canonicalJson(event_i without hash) )
 *
 * Tampering with record i invalidates every record after it, so the chain is
 * TAMPER-EVIDENT. It is not tamper-resistant: host root can rewrite the whole
 * chain (documented as RR-6). The log lives outside every container mount, so
 * nothing running inside a sandbox can reach it.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Evidence, GateId, SafetyEvent, Verdict } from "./types.js";
import type { Redactor } from "./redact.js";

export const GENESIS = "0".repeat(64);

/**
 * T7 - configurable capture level. Traces are useful and dangerous for the same
 * reason: they describe exactly what happened. The level bounds what is written
 * at all, so an operator can trade diagnosability against exposure rather than
 * relying on redaction alone.
 *
 *   minimal  - decision, rule and actor ids. No evidence payload.
 *   standard - plus evidence, redacted. The default.
 *   full     - standard, and reserved for future high-cardinality detail.
 */
export type CaptureLevel = "minimal" | "standard" | "full";

export interface RetentionOptions {
  /** Hard cap on retained records. Oldest are pruned first. */
  readonly maxEvents: number;
  /** Records older than this are pruned on the next append. */
  readonly maxAgeMs: number;
}

export const DEFAULT_RETENTION: RetentionOptions = {
  maxEvents: 5_000,
  maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
};

function canonicalJson(event: Omit<SafetyEvent, "hash">): string {
  return JSON.stringify([
    event.eventId,
    event.runId,
    event.agentId,
    event.seq,
    event.ts,
    event.gate,
    event.verdict.decision,
    event.verdict.ruleId,
    event.verdict.policyHash,
    event.evidence,
    event.prevHash,
  ]);
}

export function hashEvent(event: Omit<SafetyEvent, "hash">): string {
  return createHash("sha256")
    .update(event.prevHash)
    .update(canonicalJson(event))
    .digest("hex");
}

export interface AppendInput {
  readonly runId: string;
  readonly agentId: string;
  readonly gate: GateId;
  readonly verdict: Verdict;
  readonly evidence?: Evidence;
}

export class AuditLog {
  private events: SafetyEvent[] = [];
  private head = GENESIS;
  private seqByRun = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  /**
   * Hash of the last pruned record. Retention and tamper-evidence are in real
   * tension: dropping record i breaks a chain verified from GENESIS. Anchoring
   * at the last pruned hash keeps verification exact over the RETAINED window
   * and makes the discontinuity explicit rather than silent.
   */
  private anchor = GENESIS;
  private prunedCount = 0;

  constructor(
    private readonly filePath: string,
    private readonly redactor: Redactor,
    private readonly captureLevel: CaptureLevel = "standard",
    private readonly retention: RetentionOptions = DEFAULT_RETENTION,
    private readonly now: () => number = Date.now,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as SafetyEvent;
        this.events.push(event);
        this.head = event.hash;
        const current = this.seqByRun.get(event.runId) ?? -1;
        if (event.seq > current) this.seqByRun.set(event.runId, event.seq);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  append(input: AppendInput): SafetyEvent {
    const seq = (this.seqByRun.get(input.runId) ?? -1) + 1;
    this.seqByRun.set(input.runId, seq);

    const unhashed: Omit<SafetyEvent, "hash"> = {
      eventId: randomUUID(),
      runId: input.runId,
      agentId: input.agentId,
      seq,
      // Same clock the retention cutoff uses, so the two cannot disagree.
      ts: new Date(this.now()).toISOString(),
      gate: input.gate,
      verdict: this.redactor.value(input.verdict),
      // T7: at "minimal" the evidence payload is never written, so it cannot
      // leak from the store, the API, or a backup.
      evidence:
        this.captureLevel === "minimal"
          ? {}
          : this.redactor.value(input.evidence ?? {}),
      prevHash: this.head,
    };
    const event: SafetyEvent = { ...unhashed, hash: hashEvent(unhashed) };

    this.events.push(event);
    this.head = event.hash;
    this.prune();

    const line = JSON.stringify(event) + "\n";
    this.queue = this.queue
      .then(() => appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 }))
      .catch(() => undefined);

    return event;
  }

  /** T7 - retention. Drops the oldest records and advances the anchor. */
  private prune(): void {
    const cutoff = this.now() - this.retention.maxAgeMs;
    let drop = 0;
    while (drop < this.events.length) {
      const event = this.events[drop];
      if (!event) break;
      const tooOld = Date.parse(event.ts) < cutoff;
      const tooMany = this.events.length - drop > this.retention.maxEvents;
      if (!tooOld && !tooMany) break;
      drop += 1;
    }
    if (drop === 0) return;

    const lastPruned = this.events[drop - 1];
    if (lastPruned) this.anchor = lastPruned.hash;
    this.events = this.events.slice(drop);
    this.prunedCount += drop;
  }

  get retained(): number {
    return this.events.length;
  }

  get pruned(): number {
    return this.prunedCount;
  }

  get chainAnchor(): string {
    return this.anchor;
  }

  get level(): CaptureLevel {
    return this.captureLevel;
  }

  /** Waits for buffered writes so a test can assert on the file. */
  async flush(): Promise<void> {
    await this.queue;
  }

  byRun(runId: string): SafetyEvent[] {
    return this.events.filter((event) => event.runId === runId);
  }

  recent(limit = 100): SafetyEvent[] {
    return this.events.slice(-limit);
  }

  get chainHead(): string {
    return this.head;
  }

  /**
   * Recomputes the chain over the retained window. Returns the index of the
   * first bad record, or -1. Verification starts at the anchor, so pruning is
   * an explicit discontinuity rather than a silent verification failure.
   */
  verify(events: readonly SafetyEvent[] = this.events): number {
    let previous = events === this.events ? this.anchor : (events[0]?.prevHash ?? GENESIS);
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event) return index;
      if (event.prevHash !== previous) return index;
      const { hash, ...rest } = event;
      if (hashEvent(rest) !== hash) return index;
      previous = hash;
    }
    return -1;
  }
}
