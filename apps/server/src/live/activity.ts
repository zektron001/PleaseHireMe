/**
 * Live Agent activity.
 *
 * The reel this borrows from shows "watch what every Agent is typing". The
 * honest version of that is not a typing animation: it is the Agent's REAL
 * event stream, which Codex already emits as JSONL and which both runners
 * already hand to `inspect` line by line for AEGIS. This taps the same stream.
 *
 * So every row on the board happened. Nothing here is interpolated, replayed at
 * a pretty speed, or invented to fill a gap - if an Agent is quiet, the board is
 * quiet, which is itself information.
 *
 * Deliberately NOT here: character-level cursors. Codex reports items, not
 * keystrokes, so a cursor would be fabricated. Section-level presence is what
 * the backend actually knows.
 */

import { randomUUID } from "node:crypto";

export type ActivityKind =
  | "prompt"
  | "turn-started"
  | "thinking"
  | "message"
  | "command"
  | "file-change"
  | "turn-completed"
  | "blocked";

/** Why the Agent was running. All three spend the same warrant and container. */
export type ActivityPurpose = "turn" | "consultation" | "reiteration";

export interface ActivityEvent {
  readonly id: string;
  readonly at: string;
  readonly agentId: string;
  readonly subtaskId: string | null;
  /** The human who spent this Agent's authority. Never inferred. */
  readonly humanId: string | null;
  readonly purpose: ActivityPurpose;
  readonly kind: ActivityKind;
  /** Short, safe, already truncated. Never a full file or a whole prompt. */
  readonly detail: string;
  /** Only on turn-completed, and only what the runner actually reported. */
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly model?: string;
  };
}

/** Running totals per Agent. Every number came off a real RunnerResult. */
export interface AgentUsage {
  agentId: string;
  humanId: string | null;
  model: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  lastAt: string | null;
}

const MAX_DETAIL = 300;
const RING = 300;

function trim(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_DETAIL
    ? collapsed.slice(0, MAX_DETAIL - 1) + "…"
    : collapsed;
}

/**
 * Turns one Codex JSONL line into an activity row, or null when the line is not
 * something a human would want to watch.
 */
export function parseActivity(line: string): { kind: ActivityKind; detail: string } | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = typeof event["type"] === "string" ? (event["type"] as string) : "";

  if (type === "turn.started") return { kind: "turn-started", detail: "Turn started" };
  if (type === "turn.completed") return { kind: "turn-completed", detail: "Turn complete" };

  if (type === "item.started" || type === "item.completed") {
    const item = event["item"];
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const itemType = typeof record["type"] === "string" ? (record["type"] as string) : "";
    const done = type === "item.completed";

    if (itemType === "agent_message" && typeof record["text"] === "string") {
      return done ? { kind: "message", detail: trim(record["text"]) } : null;
    }
    if (itemType === "reasoning") {
      const text = typeof record["text"] === "string" ? record["text"] : "";
      return { kind: "thinking", detail: text ? trim(text) : "Thinking" };
    }
    if (itemType === "command_execution") {
      const command = typeof record["command"] === "string" ? record["command"] : "";
      return {
        kind: "command",
        detail: (done ? "Ran " : "Running ") + (command ? trim(command) : "a command"),
      };
    }
    if (itemType === "file_change" || itemType === "patch_apply") {
      const changes = Array.isArray(record["changes"]) ? record["changes"] : [];
      const paths = changes
        .map((change) =>
          change && typeof change === "object"
            ? String((change as Record<string, unknown>)["path"] ?? "")
            : "",
        )
        .filter(Boolean);
      return {
        kind: "file-change",
        detail: (done ? "Edited " : "Editing ") + (paths.length ? paths.join(", ") : "a file"),
      };
    }
  }
  return null;
}

/** In-process fan-out. One board per server, which is what CONCORD assumes too. */
export class ActivityBus {
  private readonly recent: ActivityEvent[] = [];
  private readonly subscribers = new Set<(event: ActivityEvent) => void>();
  private readonly usage = new Map<string, AgentUsage>();

  publish(input: Omit<ActivityEvent, "id" | "at">): ActivityEvent {
    const event: ActivityEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...input,
    };
    if (event.kind === "turn-completed") this.settle(event);
    this.recent.push(event);
    if (this.recent.length > RING) this.recent.splice(0, this.recent.length - RING);
    for (const subscriber of [...this.subscribers]) {
      // One broken stream must not stop the others being served.
      try {
        subscriber(event);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
    return event;
  }

  /**
   * Token totals, accumulated only from what a completed run reported. An Agent
   * with no row has not run; a row with zero tokens ran and the runner reported
   * none. Neither is estimated.
   */
  private settle(event: ActivityEvent): void {
    const row = this.usage.get(event.agentId) ?? {
      agentId: event.agentId,
      humanId: event.humanId,
      model: null,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastAt: null,
    };
    row.turns += 1;
    row.humanId = event.humanId ?? row.humanId;
    row.model = event.usage?.model ?? row.model;
    row.inputTokens += event.usage?.inputTokens ?? 0;
    row.outputTokens += event.usage?.outputTokens ?? 0;
    row.lastAt = event.at;
    this.usage.set(event.agentId, row);
  }

  usageFor(agentIds: readonly string[] | null): AgentUsage[] {
    const rows = [...this.usage.values()];
    return agentIds === null ? rows : rows.filter((row) => agentIds.includes(row.agentId));
  }

  history(limit = 100, agentIds: readonly string[] | null = null): ActivityEvent[] {
    const visible =
      agentIds === null
        ? this.recent
        : this.recent.filter((event) => agentIds.includes(event.agentId));
    return visible.slice(Math.max(0, visible.length - limit)).reverse();
  }

  /**
   * The tap. Returns the `inspect` hook to hand the runner, plus the two
   * bookends the stream itself cannot report: who asked, and what it cost.
   *
   * `inspect`'s return value is ignored by the guarded runner on purpose - an
   * observer must never be able to abort a run - so this is read-only by
   * construction, not by promise.
   */
  watch(context: {
    agentId: string;
    subtaskId: string | null;
    humanId: string | null;
    purpose: ActivityPurpose;
    /** Redacted to a short summary by the caller. Never the compiled prompt. */
    prompt?: string;
    model?: string;
  }): {
    inspect: (line: string) => boolean;
    finish: (usage: { inputTokens?: number; outputTokens?: number } | null) => void;
    fail: (reason: string) => void;
  } {
    const base = {
      agentId: context.agentId,
      subtaskId: context.subtaskId,
      humanId: context.humanId,
      purpose: context.purpose,
    };
    if (context.prompt) {
      this.publish({ ...base, kind: "prompt", detail: trim(context.prompt) });
    }
    return {
      inspect: (line: string): boolean => {
        const parsed = parseActivity(line);
        // turn.completed arrives before usage is known, so the bookend below
        // reports it instead. Publishing both would double-count every turn.
        if (parsed && parsed.kind !== "turn-completed") {
          this.publish({ ...base, kind: parsed.kind, detail: parsed.detail });
        }
        return true;
      },
      finish: (usage) => {
        this.publish({
          ...base,
          kind: "turn-completed",
          detail: "Turn complete",
          usage: {
            ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
            ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
            ...(context.model === undefined ? {} : { model: context.model }),
          },
        });
      },
      fail: (reason: string) => {
        this.publish({ ...base, kind: "blocked", detail: trim(reason) });
      },
    };
  }

  subscribe(subscriber: (event: ActivityEvent) => void): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }
}

export const activityBus = new ActivityBus();
