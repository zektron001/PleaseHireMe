/**
 * KS-9 - per-Agent circuit breaker.
 *
 *   Open      when violations within window W reach threshold
 *   HalfOpen  after cooldown tau has elapsed; admits exactly one probe
 *   Closed    otherwise
 *
 * A failed probe re-opens with tau doubled (capped), so a persistently hostile
 * Agent backs off rather than retrying at a fixed rate.
 */

import type { BreakerState } from "../types.js";

export interface BreakerOptions {
  readonly threshold: number;
  readonly windowMs: number;
  readonly cooldownMs: number;
  readonly maxCooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerOptions = {
  threshold: 1,
  windowMs: 600_000,
  cooldownMs: 60_000,
  maxCooldownMs: 900_000,
};

interface Entry {
  violations: number[];
  openedAt: number | null;
  cooldownMs: number;
  probeInFlight: boolean;
}

export class BreakerRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly options: BreakerOptions = DEFAULT_BREAKER,
    private readonly now: () => number = Date.now,
  ) {}

  private entry(agentId: string): Entry {
    let found = this.entries.get(agentId);
    if (!found) {
      found = {
        violations: [],
        openedAt: null,
        cooldownMs: this.options.cooldownMs,
        probeInFlight: false,
      };
      this.entries.set(agentId, found);
    }
    return found;
  }

  state(agentId: string): BreakerState {
    const entry = this.entry(agentId);
    const t = this.now();
    entry.violations = entry.violations.filter(
      (at) => t - at <= this.options.windowMs,
    );

    if (entry.openedAt === null) return "Closed";
    if (t - entry.openedAt > entry.cooldownMs) return "HalfOpen";
    return "Open";
  }

  /** True when the Agent may start a run right now. */
  admits(agentId: string): boolean {
    const state = this.state(agentId);
    if (state === "Open") return false;
    if (state === "HalfOpen") {
      const entry = this.entry(agentId);
      if (entry.probeInFlight) return false;
      entry.probeInFlight = true;
    }
    return true;
  }

  recordViolation(agentId: string): BreakerState {
    const entry = this.entry(agentId);
    const t = this.now();
    entry.violations = entry.violations.filter(
      (at) => t - at <= this.options.windowMs,
    );
    entry.violations.push(t);

    const wasHalfOpen = entry.openedAt !== null;
    if (entry.violations.length >= this.options.threshold) {
      if (wasHalfOpen) {
        entry.cooldownMs = Math.min(
          entry.cooldownMs * 2,
          this.options.maxCooldownMs,
        );
      }
      entry.openedAt = t;
    }
    entry.probeInFlight = false;
    return this.state(agentId);
  }

  recordSuccess(agentId: string): BreakerState {
    const entry = this.entry(agentId);
    entry.violations = [];
    entry.openedAt = null;
    entry.cooldownMs = this.options.cooldownMs;
    entry.probeInFlight = false;
    return "Closed";
  }

  snapshot(): Record<string, BreakerState> {
    const out: Record<string, BreakerState> = {};
    for (const agentId of this.entries.keys()) out[agentId] = this.state(agentId);
    return out;
  }
}
