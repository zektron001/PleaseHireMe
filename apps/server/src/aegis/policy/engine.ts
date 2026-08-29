/**
 * PDP - Policy Decision Point.
 *
 * Pure: no I/O, no clock, no randomness. Every negative case is therefore a
 * table-driven unit test that runs in CI without Docker, Ark, or a network,
 * which is what makes "the malicious run is denied" provable on every commit
 * rather than only on stage.
 *
 * Combining algorithm: deny-overrides on a default-deny base.
 *
 *   D(r) = Deny   if some rule denies
 *          Allow  if some rule allows and none denies
 *          Deny   otherwise
 *
 * Three properties follow, each asserted by a test:
 *   monotone in denials - adding a rule can never weaken the policy
 *   total               - an unknown request denies rather than crashing
 *   fail-closed         - a predicate that throws degrades to Deny
 */

import type { PolicyBundle, PolicyRequest, Verdict } from "../types.js";
import { bundleHash } from "./bundle.js";

const DEFAULT_DENY_RULE = "AEGIS.default-deny";
const PREDICATE_FAULT_RULE = "AEGIS.predicate-fault";

export class PolicyEngine {
  private readonly hash: string;

  constructor(private readonly bundle: PolicyBundle) {
    this.hash = bundleHash(bundle);
  }

  get policyVersion(): string {
    return this.bundle.version;
  }

  get policyHash(): string {
    return this.hash;
  }

  /** Rule identities, for GET /api/aegis/policy. Never exposes predicates. */
  summary(): { id: string; effect: string; gate: string; severity: string }[] {
    return this.bundle.rules.map((rule) => ({
      id: rule.id,
      effect: rule.effect,
      gate: rule.gate,
      severity: rule.severity,
    }));
  }

  evaluate(request: PolicyRequest): Verdict {
    const applicable = this.bundle.rules.filter(
      (rule) => rule.gate === request.context.gate,
    );

    let allow: Verdict | null = null;

    for (const rule of applicable) {
      let matched: boolean;
      try {
        matched = rule.when(request);
      } catch {
        // Fail-closed: a bug in a predicate must degrade to refusal, never to
        // permission.
        return this.verdict(request, {
          decision: "Deny",
          ruleId: PREDICATE_FAULT_RULE,
          reason: "Policy predicate " + rule.id + " failed to evaluate",
          severity: "critical",
        });
      }
      if (!matched) continue;

      if (rule.effect === "Deny") {
        // Deny overrides: return immediately, no further rules can rescue it.
        return this.verdict(request, {
          decision: "Deny",
          ruleId: rule.id,
          reason: rule.reason,
          severity: rule.severity,
        });
      }
      allow ??= this.verdict(request, {
        decision: "Allow",
        ruleId: rule.id,
        reason: rule.reason,
        severity: rule.severity,
      });
    }

    return (
      allow ??
      this.verdict(request, {
        decision: "Deny",
        ruleId: DEFAULT_DENY_RULE,
        reason: "No rule permits this action",
        severity: "warn",
      })
    );
  }

  /** Convenience: true when every request in the batch is allowed. */
  firstDenial(requests: readonly PolicyRequest[]): Verdict | null {
    for (const request of requests) {
      const verdict = this.evaluate(request);
      if (verdict.decision === "Deny") return verdict;
    }
    return null;
  }

  private verdict(
    request: PolicyRequest,
    parts: Pick<Verdict, "decision" | "ruleId" | "reason" | "severity">,
  ): Verdict {
    return {
      ...parts,
      gate: request.context.gate,
      policyVersion: this.bundle.version,
      policyHash: this.hash,
    };
  }
}
