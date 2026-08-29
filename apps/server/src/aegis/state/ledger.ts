/**
 * Budget ledger - the runaway-cost control (AC-6).
 *
 * Reserve-then-settle: the estimate is debited BEFORE the run and reconciled to
 * the realised cost AFTER, so concurrent admissions cannot jointly overshoot the
 * budget. A pure reservation model is what makes the admission predicate in the
 * architecture doc actually hold under concurrency.
 *
 *   C  = (p_in*(T_in - T_cache) + p_cache*T_cache + p_out*T_out) / 1e6
 *   C^ = max(kappa * mean(C_agent), C_min)
 */

import type { RunUsage } from "../../types.js";

export interface Pricing {
  readonly inputPerMillionUsd: number;
  readonly cachedInputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
}

export interface LedgerOptions {
  readonly agentBudgetUsd: number;
  readonly tenantBudgetUsd: number;
  readonly pricing: Pricing;
  readonly kappa: number;
  readonly minEstimateUsd: number;
}

export const DEFAULT_LEDGER: LedgerOptions = {
  agentBudgetUsd: 0.5,
  tenantBudgetUsd: 5,
  pricing: {
    inputPerMillionUsd: 0.6,
    cachedInputPerMillionUsd: 0.15,
    outputPerMillionUsd: 2.4,
  },
  kappa: 1.5,
  minEstimateUsd: 0.01,
};

interface AgentLedger {
  settledUsd: number;
  reservedUsd: number;
  runs: number;
}

export function realisedCost(usage: RunUsage | null, pricing: Pricing): number {
  if (!usage) return 0;
  const cached = usage.cachedInputTokens ?? 0;
  const input = Math.max((usage.inputTokens ?? 0) - cached, 0);
  const output = usage.outputTokens ?? 0;
  return (
    (input * pricing.inputPerMillionUsd +
      cached * pricing.cachedInputPerMillionUsd +
      output * pricing.outputPerMillionUsd) /
    1_000_000
  );
}

export class BudgetLedger {
  private readonly agents = new Map<string, AgentLedger>();
  private tenantSettledUsd = 0;
  private tenantReservedUsd = 0;

  constructor(private readonly options: LedgerOptions = DEFAULT_LEDGER) {}

  private entry(agentId: string): AgentLedger {
    let found = this.agents.get(agentId);
    if (!found) {
      found = { settledUsd: 0, reservedUsd: 0, runs: 0 };
      this.agents.set(agentId, found);
    }
    return found;
  }

  /** Trailing-mean estimate with a safety factor, floored at minEstimateUsd. */
  estimate(agentId: string): number {
    const entry = this.entry(agentId);
    const mean = entry.runs > 0 ? entry.settledUsd / entry.runs : 0;
    return Math.max(this.options.kappa * mean, this.options.minEstimateUsd);
  }

  usedUsd(agentId: string): number {
    const entry = this.entry(agentId);
    return entry.settledUsd + entry.reservedUsd;
  }

  remainingUsd(agentId: string): number {
    const agentLeft = this.options.agentBudgetUsd - this.usedUsd(agentId);
    const tenantLeft =
      this.options.tenantBudgetUsd - (this.tenantSettledUsd + this.tenantReservedUsd);
    return Math.max(Math.min(agentLeft, tenantLeft), 0);
  }

  /** Debits the estimate. Returns false when the reservation does not fit. */
  reserve(agentId: string, amountUsd: number): boolean {
    if (amountUsd > this.remainingUsd(agentId)) return false;
    this.entry(agentId).reservedUsd += amountUsd;
    this.tenantReservedUsd += amountUsd;
    return true;
  }

  /** Replaces the reservation with the realised cost. */
  settle(agentId: string, reservedUsd: number, usage: RunUsage | null): number {
    const actual = realisedCost(usage, this.options.pricing);
    const entry = this.entry(agentId);
    entry.reservedUsd = Math.max(entry.reservedUsd - reservedUsd, 0);
    this.tenantReservedUsd = Math.max(this.tenantReservedUsd - reservedUsd, 0);
    entry.settledUsd += actual;
    entry.runs += 1;
    this.tenantSettledUsd += actual;
    return actual;
  }

  /** Releases a reservation for a run that never spent anything. */
  release(agentId: string, reservedUsd: number): void {
    const entry = this.entry(agentId);
    entry.reservedUsd = Math.max(entry.reservedUsd - reservedUsd, 0);
    this.tenantReservedUsd = Math.max(this.tenantReservedUsd - reservedUsd, 0);
  }

  snapshot(): {
    tenantUsedUsd: number;
    tenantBudgetUsd: number;
    agents: Record<string, { usedUsd: number; budgetUsd: number }>;
  } {
    const agents: Record<string, { usedUsd: number; budgetUsd: number }> = {};
    for (const [agentId] of this.agents) {
      agents[agentId] = {
        usedUsd: this.usedUsd(agentId),
        budgetUsd: this.options.agentBudgetUsd,
      };
    }
    return {
      tenantUsedUsd: this.tenantSettledUsd + this.tenantReservedUsd,
      tenantBudgetUsd: this.options.tenantBudgetUsd,
      agents,
    };
  }
}
